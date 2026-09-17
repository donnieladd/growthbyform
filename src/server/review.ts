// The review queue: resolving persons.review_flag. capture (identity.ts)
// never guesses a merge — it flags a possible duplicate and creates a second
// record instead. This module is what a human does with that flag: confirm
// it's a real duplicate and merge the two records, or dismiss the flag
// because it isn't.
//
// A merge re-points every piece of the loser's history onto the survivor —
// visits (renumbered to avoid colliding with the survivor's own numbering),
// connect-card submissions, step completions (a colliding step_key is
// dropped as redundant, not duplicated), decisions, stage history, and
// contact log — then deletes the now-empty loser row. persons.visit_count,
// first_visit_at/last_visit_at and last_contact_at are NOT touched directly:
// the existing rollup triggers (0002/0003) fire on every re-point UPDATE and
// recompute the survivor's numbers correctly on their own.

import { createServerFn } from "@tanstack/react-start";
import { SESSION_COOKIE } from "../lib/session-constants";

export const REVIEW_FLAG_LABELS: Record<string, string> = {
  possible_duplicate_name_only: "Same name matched, nothing else confirmed it was the same person",
  self_reported_returning_no_history: "Said they'd been here before, but there's no record of them",
  ambiguous_match_most_recent_chosen: "Matched more than one existing person — the most recent one was kept",
  phone_shared_different_name: "Same phone number as an existing person, but a different name",
};

export function reviewFlagLabel(flag: string | null): string | null {
  if (!flag) return null;
  return REVIEW_FLAG_LABELS[flag] ?? flag.replaceAll("_", " ");
}

export type PersonSummary = {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  householdName: string | null;
  stageName: string | null;
  visitCount: number;
  decisionCount: number;
  createdOn: string | null;
  reviewFlag: string | null;
};

const PERSON_SUMMARY_SQL = `select
   p.id, p.full_name, p.email, p.phone, h.name as household_name,
   s.name as stage_name, p.visit_count,
   (select count(*) from decision_events d where d.person_id = p.id) as decision_count,
   to_char(p.created_at, 'YYYY-MM-DD"T"HH24:MI') as created_on,
   p.review_flag
 from persons p
 left join households h on h.id = p.household_id
 left join growth_track_stages s on s.id = p.current_stage_id`;

type PersonSummaryRow = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  household_name: string | null;
  stage_name: string | null;
  visit_count: number;
  decision_count: string;
  created_on: string | null;
  review_flag: string | null;
};

function toSummary(row: PersonSummaryRow): PersonSummary {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    householdName: row.household_name,
    stageName: row.stage_name,
    visitCount: row.visit_count,
    decisionCount: Number(row.decision_count),
    createdOn: row.created_on,
    reviewFlag: row.review_flag,
  };
}

export type ReviewQueueResult =
  | { state: "ok"; churchName: string; people: PersonSummary[] }
  | { state: "unauthenticated" }
  | { state: "setup-required"; message: string };

export const getReviewQueue = createServerFn({ method: "GET" }).handler(async (): Promise<ReviewQueueResult> => {
  const [{ getCookie }, { requireStaff }, { query }] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("./auth-core"),
    import("../lib/pg"),
  ]);

  const auth = await requireStaff(getCookie(SESSION_COOKIE));
  if (!auth.ok) {
    if (auth.state === "db-unavailable") {
      return { state: "setup-required", message: auth.message ?? "The database is not reachable." };
    }
    return { state: "unauthenticated" };
  }

  const rows = await query<PersonSummaryRow>(
    `${PERSON_SUMMARY_SQL} where p.church_id = $1 and p.review_flag is not null order by p.created_at asc`,
    [auth.session.churchId],
  );
  return { state: "ok", churchName: auth.session.churchName, people: rows.map(toSummary) };
});

export type MergeCandidatesResult =
  | { state: "ok"; churchName: string; person: PersonSummary; candidates: PersonSummary[] }
  | { state: "not-found" }
  | { state: "unauthenticated" }
  | { state: "setup-required"; message: string };

export const getMergeCandidates = createServerFn({ method: "GET" })
  .validator((input: { personId?: unknown }) => ({
    personId: typeof input?.personId === "string" ? input.personId : "",
  }))
  .handler(async ({ data }): Promise<MergeCandidatesResult> => {
    const [{ getCookie }, { requireStaff }, { query }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("./auth-core"),
      import("../lib/pg"),
    ]);

    const auth = await requireStaff(getCookie(SESSION_COOKIE));
    if (!auth.ok) {
      if (auth.state === "db-unavailable") {
        return { state: "setup-required", message: auth.message ?? "The database is not reachable." };
      }
      return { state: "unauthenticated" };
    }
    if (!data.personId) return { state: "not-found" };

    const [personRow] = await query<PersonSummaryRow>(`${PERSON_SUMMARY_SQL} where p.id = $1 and p.church_id = $2`, [
      data.personId,
      auth.session.churchId,
    ]);
    if (!personRow) return { state: "not-found" };

    // Same signals identity.ts's own capture-time matching uses, so "who
    // might this be" here means the same thing it meant when the flag was
    // first raised: phone, email, or exact normalized name.
    const candidateRows = await query<PersonSummaryRow>(
      `${PERSON_SUMMARY_SQL}
        where p.church_id = $1 and p.id <> $2
          and (
            (p.phone_e164 is not null and p.phone_e164 = (select phone_e164 from persons where id = $2))
            or (p.email_lower is not null and p.email_lower = (select email_lower from persons where id = $2))
            or (p.name_normalized = (select name_normalized from persons where id = $2))
          )
        order by p.created_at desc
        limit 10`,
      [auth.session.churchId, data.personId],
    );

    return {
      state: "ok",
      churchName: auth.session.churchName,
      person: toSummary(personRow),
      candidates: candidateRows.map(toSummary),
    };
  });

export type SearchPeopleResult =
  | { state: "ok"; results: PersonSummary[] }
  | { state: "unauthenticated" }
  | { state: "setup-required"; message: string };

export const searchPeople = createServerFn({ method: "GET" })
  .validator((input: { query?: unknown; excludeId?: unknown }) => ({
    query: typeof input?.query === "string" ? input.query.trim().slice(0, 200) : "",
    excludeId: typeof input?.excludeId === "string" ? input.excludeId : null,
  }))
  .handler(async ({ data }): Promise<SearchPeopleResult> => {
    const [{ getCookie }, { requireStaff }, { query }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("./auth-core"),
      import("../lib/pg"),
    ]);

    const auth = await requireStaff(getCookie(SESSION_COOKIE));
    if (!auth.ok) {
      if (auth.state === "db-unavailable") {
        return { state: "setup-required", message: auth.message ?? "The database is not reachable." };
      }
      return { state: "unauthenticated" };
    }
    if (!data.query) return { state: "ok", results: [] };

    const rows = await query<PersonSummaryRow>(
      `${PERSON_SUMMARY_SQL}
        where p.church_id = $1 and p.full_name ilike $2
          and ($3::uuid is null or p.id <> $3)
        order by p.full_name
        limit 10`,
      [auth.session.churchId, `%${data.query}%`, data.excludeId],
    );
    return { state: "ok", results: rows.map(toSummary) };
  });

export type MergeResult =
  | { state: "ok"; message: string }
  | { state: "error"; message: string }
  | { state: "unauthenticated" }
  | { state: "setup-required"; message: string };

export const mergePersons = createServerFn({ method: "POST" })
  .validator((input: { keepId?: unknown; mergeId?: unknown; reason?: unknown }) => ({
    keepId: typeof input?.keepId === "string" ? input.keepId : "",
    mergeId: typeof input?.mergeId === "string" ? input.mergeId : "",
    reason: typeof input?.reason === "string" ? input.reason.trim().slice(0, 1000) : "",
  }))
  .handler(async ({ data }): Promise<MergeResult> => {
    const [{ getCookie }, { requireStaff }, { withTransaction }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("./auth-core"),
      import("../lib/pg"),
    ]);

    const auth = await requireStaff(getCookie(SESSION_COOKIE));
    if (!auth.ok) {
      if (auth.state === "db-unavailable") {
        return { state: "setup-required", message: auth.message ?? "The database is not reachable." };
      }
      return { state: "unauthenticated" };
    }
    if (!data.keepId || !data.mergeId || data.keepId === data.mergeId) {
      return { state: "error", message: "Pick two different people to merge." };
    }

    const churchId = auth.session.churchId;

    try {
      await withTransaction(async (client) => {
        type PersonRow = {
          id: string;
          email: string | null;
          email_lower: string | null;
          phone: string | null;
          phone_e164: string | null;
          address_normalized: string | null;
          household_id: string | null;
        };

        // Lock both rows for the duration — a concurrent edit to either
        // person mid-merge would otherwise be silently lost.
        const [keep] = (
          await client.query<PersonRow>(
            `select id, email, email_lower, phone, phone_e164, address_normalized, household_id
               from persons where id = $1 and church_id = $2 for update`,
            [data.keepId, churchId],
          )
        ).rows;
        const [merge] = (
          await client.query<PersonRow & { full_name: string }>(
            `select id, full_name, email, email_lower, phone, phone_e164, address_normalized, household_id
               from persons where id = $1 and church_id = $2 for update`,
            [data.mergeId, churchId],
          )
        ).rows;
        if (!keep || !merge) {
          throw new Error("One of those people is not on this church's list.");
        }

        // Fill gaps on the survivor from the merged-away record — never
        // overwrite something the survivor already has.
        await client.query(
          `update persons set
             email = coalesce(email, $2), email_lower = coalesce(email_lower, $3),
             phone = coalesce(phone, $4), phone_e164 = coalesce(phone_e164, $5),
             address_normalized = coalesce(address_normalized, $6),
             household_id = coalesce(household_id, $7),
             review_flag = null,
             updated_at = now()
           where id = $1`,
          [
            keep.id,
            merge.email,
            merge.email_lower,
            merge.phone,
            merge.phone_e164,
            merge.address_normalized,
            merge.household_id,
          ],
        );

        // Visits: renumber the merged-away person's visits to continue after
        // the survivor's own, so (person_id, visit_number) never collides.
        const [{ max_visit }] = (
          await client.query<{ max_visit: number }>(
            `select coalesce(max(visit_number), 0) as max_visit from person_visits where person_id = $1`,
            [keep.id],
          )
        ).rows;
        await client.query(
          `update person_visits pv
              set person_id = $1, visit_number = sub.rn + $2
             from (
               select id, row_number() over (order by visit_number) as rn
                 from person_visits where person_id = $3
             ) sub
            where pv.id = sub.id`,
          [keep.id, max_visit, merge.id],
        );

        await client.query(`update connect_card_submissions set person_id = $1 where person_id = $2`, [
          keep.id,
          merge.id,
        ]);
        await client.query(`update connect_card_submissions set matched_person_id = $1 where matched_person_id = $2`, [
          keep.id,
          merge.id,
        ]);

        // Step completions: a step both people already completed is the same
        // real step, done once — drop the redundant row rather than keep two.
        await client.query(
          `delete from step_completions
            where person_id = $1
              and step_key in (select step_key from step_completions where person_id = $2)`,
          [merge.id, keep.id],
        );
        await client.query(`update step_completions set person_id = $1 where person_id = $2`, [keep.id, merge.id]);

        // Decisions and interactions are never unique per person — safe to
        // re-point wholesale.
        await client.query(`update decision_events set person_id = $1 where person_id = $2`, [keep.id, merge.id]);
        await client.query(`update person_interactions set person_id = $1 where person_id = $2`, [keep.id, merge.id]);
        await client.query(`update stage_history set person_id = $1 where person_id = $2`, [keep.id, merge.id]);

        await client.query(
          `insert into person_merges (church_id, kept_person_id, merged_person_snapshot, reason, merged_by_staff_id)
           values ($1, $2, to_jsonb((select m from (select * from persons where id = $3) m)), $4, $5)`,
          [churchId, keep.id, merge.id, data.reason || null, auth.session.staffUserId],
        );

        // Everything that referenced merge.id has been re-pointed above —
        // this delete now succeeds cleanly with nothing left to cascade.
        await client.query(`delete from persons where id = $1`, [merge.id]);
      });

      return { state: "ok", message: "Merged. The duplicate's history now lives on the record you kept." };
    } catch (err) {
      console.error("mergePersons failed", err);
      return { state: "error", message: "That merge did not complete." };
    }
  });

export type DismissResult =
  | { state: "ok" }
  | { state: "error"; message: string }
  | { state: "unauthenticated" }
  | { state: "setup-required"; message: string };

export const dismissReviewFlag = createServerFn({ method: "POST" })
  .validator((input: { personId?: unknown }) => ({
    personId: typeof input?.personId === "string" ? input.personId : "",
  }))
  .handler(async ({ data }): Promise<DismissResult> => {
    const [{ getCookie }, { requireStaff }, { query }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("./auth-core"),
      import("../lib/pg"),
    ]);

    const auth = await requireStaff(getCookie(SESSION_COOKIE));
    if (!auth.ok) {
      if (auth.state === "db-unavailable") {
        return { state: "setup-required", message: auth.message ?? "The database is not reachable." };
      }
      return { state: "unauthenticated" };
    }
    if (!data.personId) return { state: "error", message: "No person specified." };

    try {
      await query(`update persons set review_flag = null, updated_at = now() where id = $1 and church_id = $2`, [
        data.personId,
        auth.session.churchId,
      ]);
      return { state: "ok" };
    } catch (err) {
      console.error("dismissReviewFlag failed", err);
      return { state: "error", message: "That could not be saved." };
    }
  });
