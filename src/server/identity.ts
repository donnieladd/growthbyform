// Identity resolution — the whole point of capture.
//
// Every intake channel funnels through resolveConnectCard(). It matches on
// phone_e164, then email_lower, then name_normalized + address/household; it
// attaches a new visit to the matched person or creates exactly one new person
// (plus a household where an address was given). A returning guest can never
// produce a second record, and their visit lands as a real visit #2.
//
// When the signals are not enough to merge safely, we do NOT guess: we create the
// record and stamp persons.review_flag so a human can merge it. Silently merging
// two people is worse than a visible possible duplicate.
//
// This module is framework-free (no request, no cookie, no TanStack import) so the
// seed script and any future import job use the very same code path as the live form.

import type { PoolClient } from "pg";
import {
  householdName,
  normalizeAddress,
  normalizeEmailLower,
  normalizeName,
  normalizePhoneE164,
} from "../lib/normalize";

export type VisitSource = "connect_card" | "kiosk" | "staff_entry";
export type VisitReport = "first_time" | "returning" | "unsure";
export type MatchedOn = "phone_e164" | "email_lower" | "name_and_address" | "household" | "no_match_created";

export type ConnectCardInput = {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  visitReport: VisitReport;
  children?: string | null;
  householdMembers?: string | null;
  howHeard?: string | null;
  prayerRequest?: string | null;
  attendedAt?: Date | null;
  source?: VisitSource;
  /** Staff user recording this on someone's behalf (kiosk / staff entry). */
  recordedByStaffId?: string | null;
};

export type StageRef = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  sequence: number;
  isTerminal: boolean;
  expectedDwellDays: number | null;
};

export type ResolutionResult = {
  personId: string;
  householdId: string | null;
  personCreated: boolean;
  householdCreated: boolean;
  matchedOn: MatchedOn;
  ambiguousCandidates: number;
  reviewFlag: string | null;
  visitId: string;
  visitNumber: number;
  isFirstVisit: boolean;
  isSecondVisit: boolean;
  visitCount: number;
  fullName: string;
  currentStage: StageRef | null;
  nextStage: StageRef | null;
  nextStep: { title: string; detail: string };
  /** Enrichment applied to an existing record (empty for a new person). */
  enrichedFields: string[];
};

const PERSON_COLUMNS =
  "id, household_id, first_name, last_name, full_name, email, email_lower, phone, phone_e164, address_normalized, review_flag, current_stage_id, visit_count";

type PersonRow = {
  id: string;
  household_id: string | null;
  first_name: string;
  last_name: string;
  full_name: string;
  email: string | null;
  email_lower: string | null;
  phone: string | null;
  phone_e164: string | null;
  address_normalized: string | null;
  review_flag: string | null;
  current_stage_id: string | null;
  visit_count: number;
};

export type ActiveStages = { configId: string; stages: StageRef[] };

export async function loadActiveStages(client: PoolClient, churchId: string): Promise<ActiveStages | null> {
  const { rows } = await client.query<{
    config_id: string;
    id: string;
    key: string;
    name: string;
    description: string | null;
    sequence: number;
    is_terminal: boolean;
    expected_dwell_days: number | null;
  }>(
    `select c.id as config_id, s.id, s.key, s.name, s.description, s.sequence,
            s.is_terminal, s.expected_dwell_days
       from growth_track_configs c
       join growth_track_stages s on s.config_id = c.id
      where c.church_id = $1 and c.is_active
      order by s.sequence`,
    [churchId],
  );
  if (rows.length === 0) return null;
  return {
    configId: rows[0].config_id,
    stages: rows.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      sequence: r.sequence,
      isTerminal: r.is_terminal,
      expectedDwellDays: r.expected_dwell_days,
    })),
  };
}

async function findOrCreateHousehold(
  client: PoolClient,
  churchId: string,
  input: {
    lastName: string;
    addressNormalized: string | null;
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    region?: string | null;
    postalCode?: string | null;
    phoneE164: string | null;
  },
): Promise<{ id: string; created: boolean } | null> {
  if (!input.addressNormalized && !input.phoneE164) return null;

  const existing = await client.query<{ id: string }>(
    `select id from households
      where church_id = $1
        and ((address_normalized is not null and address_normalized = $2)
             or ($3::text is not null and phone_e164 = $3))
      order by created_at asc
      limit 1`,
    [churchId, input.addressNormalized, input.phoneE164],
  );
  if (existing.rows.length > 0) return { id: existing.rows[0].id, created: false };
  if (!input.addressNormalized) return null;

  const created = await client.query<{ id: string }>(
    `insert into households
       (church_id, name, address_line1, address_line2, city, region, postal_code, address_normalized, phone_e164)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning id`,
    [
      churchId,
      householdName(input.lastName),
      input.addressLine1?.trim() || null,
      input.addressLine2?.trim() || null,
      input.city?.trim() || null,
      input.region?.trim() || null,
      input.postalCode?.trim() || null,
      input.addressNormalized,
      input.phoneE164,
    ],
  );
  return { id: created.rows[0].id, created: true };
}

async function householdAddressMatches(
  client: PoolClient,
  churchId: string,
  householdId: string,
  addressNormalized: string,
): Promise<boolean> {
  const { rows } = await client.query<{ ok: boolean }>(
    `select (address_normalized = $3) as ok from households where id = $2 and church_id = $1`,
    [churchId, householdId, addressNormalized],
  );
  return rows[0]?.ok === true;
}

function buildNextStep(
  currentStage: StageRef | null,
  nextStage: StageRef | null,
  visitNumber: number,
): { title: string; detail: string } {
  if (!currentStage) {
    return {
      title: "Next step: meet your coach",
      detail: "A staff member will reach out this week to walk you through what comes next.",
    };
  }
  const recurrence =
    visitNumber >= 2
      ? `That's visit #${String(visitNumber)} — coming back a second time is the strongest sign someone finds a home here, so a coach will follow up this week. `
      : "A coach will follow up with you this week. ";
  if (nextStage) {
    return {
      title: `Next step: ${nextStage.name}`,
      detail: recurrence + (nextStage.description ?? "We'll walk you through it."),
    };
  }
  return {
    title: "Next step: pour into someone else",
    detail:
      recurrence + "You've reached the end of the track — the next move is leading someone else through it.",
  };
}

/**
 * Resolve an intake submission to exactly one person, record the visit, and keep
 * the raw submission for the record. Must be called inside a transaction.
 */
export async function resolveConnectCard(
  client: PoolClient,
  churchId: string,
  input: ConnectCardInput,
): Promise<ResolutionResult> {
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const source: VisitSource = input.source ?? "connect_card";
  const emailLower = normalizeEmailLower(input.email);
  const phoneE164 = normalizePhoneE164(input.phone);
  const nameNormalized = normalizeName(firstName, lastName);
  const addressNormalized = normalizeAddress({
    addressLine1: input.addressLine1,
    addressLine2: input.addressLine2,
    city: input.city,
    region: input.region,
    postalCode: input.postalCode,
  });

  // ---- 1. Match, strongest key first -------------------------------------
  let matched: PersonRow | null = null;
  let matchedOn: MatchedOn = "no_match_created";
  let ambiguousCandidates = 0;

  if (phoneE164) {
    const { rows } = await client.query<PersonRow>(
      `select ${PERSON_COLUMNS} from persons
        where church_id = $1 and phone_e164 = $2
        order by last_visit_at desc nulls last, created_at asc`,
      [churchId, phoneE164],
    );
    if (rows.length > 0) {
      matched = rows[0];
      matchedOn = "phone_e164";
      ambiguousCandidates = rows.length - 1;
    }
  }

  if (!matched && emailLower) {
    const { rows } = await client.query<PersonRow>(
      `select ${PERSON_COLUMNS} from persons
        where church_id = $1 and email_lower = $2
        order by last_visit_at desc nulls last, created_at asc`,
      [churchId, emailLower],
    );
    if (rows.length > 0) {
      matched = rows[0];
      matchedOn = "email_lower";
      ambiguousCandidates = rows.length - 1;
    }
  }

  if (!matched && nameNormalized) {
    const { rows } = await client.query<PersonRow>(
      `select ${PERSON_COLUMNS} from persons
        where church_id = $1 and name_normalized = $2
        order by last_visit_at desc nulls last, created_at asc`,
      [churchId, nameNormalized],
    );
    if (rows.length > 0 && addressNormalized) {
      const confirmed: PersonRow[] = [];
      for (const candidate of rows) {
        if (candidate.address_normalized === addressNormalized) {
          confirmed.push(candidate);
          continue;
        }
        if (candidate.household_id) {
          const sameHouseholdAddress = await householdAddressMatches(
            client,
            churchId,
            candidate.household_id,
            addressNormalized,
          );
          if (sameHouseholdAddress) {
            confirmed.push(candidate);
            matchedOn = "household";
          }
        }
      }
      if (confirmed.length === 1) {
        matched = confirmed[0];
        if (matchedOn !== "household") matchedOn = "name_and_address";
      } else if (confirmed.length > 1) {
        ambiguousCandidates = confirmed.length;
      }
    } else if (rows.length > 0) {
      // Same name, nothing else to go on. A record gets created and flagged for a
      // human — we never merge two people on a name alone.
      ambiguousCandidates = rows.length;
    }
  }

  const stages = await loadActiveStages(client, churchId);
  const entryStage = stages?.stages[0] ?? null;
  const enrichedFields: string[] = [];
  let householdCreated = false;
  let personCreated = false;
  let reviewFlag: string | null = null;
  let person: PersonRow;

  // ---- 2. Enrich, or create ----------------------------------------------
  if (matched) {
    person = matched;
    const sets: string[] = [];
    const values: unknown[] = [];

    if (!matched.email_lower && emailLower) {
      sets.push(`email = $${String(values.length + 1)}`, `email_lower = $${String(values.length + 2)}`);
      values.push(input.email?.trim() ?? emailLower, emailLower);
      enrichedFields.push("email");
    }
    if (!matched.phone_e164 && phoneE164) {
      sets.push(`phone = $${String(values.length + 1)}`, `phone_e164 = $${String(values.length + 2)}`);
      values.push(input.phone?.trim() ?? phoneE164, phoneE164);
      enrichedFields.push("phone");
    }
    if (!matched.address_normalized && addressNormalized) {
      sets.push(`address_normalized = $${String(values.length + 1)}`);
      values.push(addressNormalized);
      enrichedFields.push("address");
    }
    if (ambiguousCandidates > 0 && !matched.review_flag) {
      sets.push(`review_flag = $${String(values.length + 1)}`);
      values.push("ambiguous_match_most_recent_chosen");
      reviewFlag = "ambiguous_match_most_recent_chosen";
      enrichedFields.push("review_flag");
    }

    let householdId = matched.household_id;
    if (!householdId) {
      const household = await findOrCreateHousehold(client, churchId, {
        lastName: matched.last_name || lastName,
        addressNormalized,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2,
        city: input.city,
        region: input.region,
        postalCode: input.postalCode,
        phoneE164: matched.phone_e164 ?? phoneE164,
      });
      if (household) {
        householdId = household.id;
        householdCreated = household.created;
        sets.push(`household_id = $${String(values.length + 1)}`);
        values.push(household.id);
        enrichedFields.push("household");
      }
    }

    if (sets.length > 0) {
      values.push(matched.id, churchId);
      await client.query(
        `update persons set ${sets.join(", ")} where id = $${String(values.length - 1)} and church_id = $${String(values.length)}`,
        values,
      );
      person = { ...matched, review_flag: reviewFlag ?? matched.review_flag, household_id: householdId };
    }
  } else {
    const household = await findOrCreateHousehold(client, churchId, {
      lastName,
      addressNormalized,
      addressLine1: input.addressLine1,
      addressLine2: input.addressLine2,
      city: input.city,
      region: input.region,
      postalCode: input.postalCode,
      phoneE164,
    });
    householdCreated = household?.created ?? false;

    if (ambiguousCandidates > 0) {
      reviewFlag = "possible_duplicate_name_only";
    } else if (input.visitReport === "returning") {
      // They told us they've been before and we have no record: either a real
      // first capture for a long-time attender, or a near-duplicate. Either way it
      // needs a human, and the flag is what keeps the merge findable.
      reviewFlag = "self_reported_returning_no_history";
    }

    const inserted = await client.query<PersonRow>(
      `insert into persons
         (church_id, household_id, first_name, last_name, email, email_lower, phone, phone_e164,
          name_normalized, address_normalized, review_flag, current_stage_id, created_via)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       returning ${PERSON_COLUMNS}`,
      [
        churchId,
        household?.id ?? null,
        firstName,
        lastName,
        input.email?.trim() || null,
        emailLower,
        input.phone?.trim() || null,
        phoneE164,
        nameNormalized,
        addressNormalized,
        reviewFlag,
        entryStage?.id ?? null,
        source,
      ],
    );
    person = inserted.rows[0];
    personCreated = true;
  }

  // ---- 3. The visit -------------------------------------------------------
  const attendedAt = input.attendedAt ?? new Date();
  let visit: { id: string; visit_number: number; attended_at: Date } | null = null;
  for (let attempt = 1; attempt <= 3 && !visit; attempt++) {
    try {
      const inserted = await client.query<{ id: string; visit_number: number; attended_at: Date }>(
        `insert into person_visits (church_id, person_id, visit_number, attended_at, source, recorded_by_staff_id)
         values ($1, $2, (select coalesce(max(visit_number), 0) + 1 from person_visits where person_id = $2), $3, $4, $5)
         returning id, visit_number, attended_at`,
        [churchId, person.id, attendedAt, source, input.recordedByStaffId ?? null],
      );
      visit = inserted.rows[0];
    } catch (err) {
      // Two submissions racing on the same person can compute the same visit
      // number; person_visits' unique key rejects the loser and we retry.
      const code = (err as { code?: string }).code;
      if (code !== "23505" || attempt === 3) throw err;
    }
  }
  if (!visit) throw new Error("could not record visit");

  // ---- 4. Keep the raw intake next to what it produced --------------------
  await client.query(
    `insert into connect_card_submissions
       (church_id, person_id, visit_id, visit_report, matched_on, matched_person_id,
        children_text, household_members_text, how_heard, prayer_request, raw)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
    [
      churchId,
      person.id,
      visit.id,
      input.visitReport,
      matchedOn,
      matched && !personCreated ? matched.id : null,
      input.children?.trim() || null,
      input.householdMembers?.trim() || null,
      input.howHeard?.trim() || null,
      input.prayerRequest?.trim() || null,
      JSON.stringify({ ...input, attendedAt: attendedAt.toISOString(), ambiguousCandidates }),
    ],
  );

  // ---- 5. Where they are, and what is next -------------------------------
  const refreshed = await client.query<{ visit_count: number; current_stage_id: string | null }>(
    `select visit_count, current_stage_id from persons where id = $1 and church_id = $2`,
    [person.id, churchId],
  );
  const visitCount = refreshed.rows[0]?.visit_count ?? visit.visit_number;
  const currentStage =
    stages?.stages.find((s) => s.id === (refreshed.rows[0]?.current_stage_id ?? person.current_stage_id)) ?? null;
  const nextStage = currentStage
    ? (stages?.stages.find((s) => s.sequence === currentStage.sequence + 1) ?? null)
    : (stages?.stages[1] ?? null);

  return {
    personId: person.id,
    householdId: person.household_id ?? null,
    personCreated,
    householdCreated,
    matchedOn,
    ambiguousCandidates,
    reviewFlag,
    visitId: visit.id,
    visitNumber: visit.visit_number,
    isFirstVisit: visit.visit_number === 1,
    isSecondVisit: visit.visit_number === 2,
    visitCount,
    fullName: `${firstName} ${lastName}`,
    currentStage,
    nextStage,
    nextStep: buildNextStep(currentStage, nextStage, visit.visit_number),
  };
}
