// Seed script.
//
//   bun run db:seed              create the demo church, staff account, the seven
//                                default stages and ~10 demo people (idempotent:
//                                refuses to double-seed an existing demo church)
//   bun run db:seed -- --reset   delete and rebuild the demo church from scratch
//
// It runs the SAME identity-resolution code as the public connect card for two of
// the demo arrivals — one brand-new guest and one returning guest whose phone
// number matches an existing person — and checks that the returning guest produced
// a second visit and no second record. It also proves the checkpoint rules bite by
// feeding the validator a deliberately broken track.
//
// Read DATABASE_URL from the environment only. Never write a .env file.

import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { PoolClient } from "pg";
import { hashPassword } from "../src/lib/auth";
import {
  householdName,
  normalizeAddress,
  normalizeEmailLower,
  normalizeName,
  normalizePhoneE164,
} from "../src/lib/normalize";
import { DbUnavailableError, closePool, withClient, withTransaction } from "../src/lib/pg";
import { resolveConnectCard } from "../src/server/identity";

const { Pool } = pg;
const here = path.dirname(fileURLToPath(import.meta.url));

const DEMO_SLUG = "demo-church";
const DEMO_PASSWORD = process.env.SEED_STAFF_PASSWORD?.trim() || "growthtrack-demo";

type StageSpec = {
  key: string;
  name: string;
  description: string;
  sequence: number;
  expectedDwellDays: number | null;
  isTerminal: boolean;
  checkpointKind: "belonging" | "self_understanding" | "leadership_character" | "deployment" | null;
};

// The seven default stages, in order, with the dwell time stall detection will read
// later. Checkpoint mapping is a starting hypothesis per church, not a product law:
// belonging first, self-understanding (knowing how you are shaped) before
// deployment last, leadership/character optional in between.
const STAGES: StageSpec[] = [
  {
    key: "first_time_guest",
    name: "First-Time Guest",
    description: "You came. A named person will follow up with you this week.",
    sequence: 1,
    expectedDwellDays: 7,
    isTerminal: false,
    checkpointKind: "belonging",
  },
  {
    key: "returning_guest",
    name: "Returning Guest",
    description: "You came back — the strongest sign you are finding a home here. Next: the Growth Track.",
    sequence: 2,
    expectedDwellDays: 14,
    isTerminal: false,
    checkpointKind: null,
  },
  {
    key: "growth_track_enrolled",
    name: "Growth Track Enrolled",
    description: "Four sessions: belonging, how God shaped you, your character, and your team.",
    sequence: 3,
    expectedDwellDays: 28,
    isTerminal: false,
    checkpointKind: null,
  },
  {
    key: "growth_track_complete",
    name: "Complete",
    description: "You finished the class and know how you are shaped.",
    sequence: 4,
    expectedDwellDays: 21,
    isTerminal: false,
    checkpointKind: "self_understanding",
  },
  {
    key: "connected",
    name: "Connected",
    description:
      "You know and are known by a named person here. Community is a destination the track feeds into — small groups are one way it happens, never a checkpoint.",
    sequence: 5,
    expectedDwellDays: 60,
    isTerminal: false,
    checkpointKind: null,
  },
  {
    key: "serving",
    name: "Serving",
    description: "You are on a team, serving in the way you are shaped.",
    sequence: 6,
    expectedDwellDays: 90,
    isTerminal: false,
    checkpointKind: "leadership_character",
  },
  {
    key: "leading",
    name: "Leading",
    description: "You are deploying other people into the same journey.",
    sequence: 7,
    expectedDwellDays: null,
    isTerminal: true,
    checkpointKind: "deployment",
  },
];

function lastSundayOnOrBefore(date: Date): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}

function daysAgo(days: number, hourUtc = 15): Date {
  const d = new Date(Date.now() - days * 86_400_000);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return lastSundayOnOrBefore(d);
}

/**
 * A precise "n days ago" timestamp, with no Sunday snapping. Stage entry times use
 * this so "days in stage" is exactly the number the seed intends: the demo has to
 * show a real, believable task list on first load, and a snapped timestamp would
 * move somebody in or out of overdue by up to six days.
 */
function exactDaysAgo(days: number, hourUtc = 16): Date {
  const d = new Date(Date.now() - days * 86_400_000);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

type PersonSpec = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address?: { line1: string; city: string; region: string; postal: string };
  stageKey: string;
  /** How many days ago this person entered their current stage (exact). The
   *  difference against the stage's expected dwell is what stall detection reads. */
  stageDaysAgo: number;
  /** Which seeded staff member owns them — this is what "my people" filters on. */
  coach: "dana" | "ruth";
  visitDaysAgo: number[];
  howHeard: string;
  children?: string;
  householdMembers?: string;
  prayerRequest?: string;
  decisions?: { type: "salvation" | "rededication" | "baptism"; daysAgo: number; notes?: string }[];
  steps?: { key: string; name: string; daysAgo: number }[];
  interactions?: {
    kind: "call" | "text" | "email" | "in_person" | "note";
    daysAgo: number;
    body?: string;
  }[];
};

// The demo church is fictional. Dwell expectations are the seeded seven stages'
// (First-Time Guest 7, Returning Guest 14, Growth Track Enrolled 28, Complete 21,
// Connected 60, Serving 90, Leading terminal), so the people below deliberately
// include both sides of every clock:
//
//   overdue    Tom Becker (First-Time Guest, 5 days over), Sam Whitfield
//              (Returning Guest, 7), Marcus Webb (Enrolled, 6), Nia Johnson
//              (Enrolled, 16), Jonah Kim (Complete, 24)
//   on pace    Grace Lin, Aisha Bello, Priya Raman, Hannah Patel, Luis Ortega,
//              and everybody who arrives through the connect card during the seed
//
// Two staff members own people, so the task list's "my people" filter has something
// real to filter on.
const PEOPLE: PersonSpec[] = [
  {
    firstName: "Marcus",
    lastName: "Webb",
    email: "marcus.webb@example.com",
    phone: "(512) 555-0142",
    address: { line1: "1412 Elm St", city: "Round Rock", region: "TX", postal: "78664" },
    stageKey: "growth_track_enrolled",
    stageDaysAgo: 34,
    coach: "dana",
    visitDaysAgo: [46, 40],
    howHeard: "My neighbour invited me",
    children: "Tessa (9), Ben (6)",
    householdMembers: "Tessa Webb (spouse)",
    prayerRequest: "For my job search.",
    steps: [
      { key: "growth_track_session_1", name: "Session 1 — Belonging", daysAgo: 40 },
      { key: "growth_track_session_2", name: "Session 2 — How you are shaped", daysAgo: 34 },
    ],
    interactions: [
      { kind: "call", daysAgo: 30, body: "Called to book him into Session 3. Going to call back once work settles." },
      { kind: "note", daysAgo: 12, body: "Says work is heavy this month but he still wants to finish the track." },
    ],
  },
  {
    firstName: "Priya",
    lastName: "Raman",
    email: "priya.raman@example.com",
    phone: "(512) 555-0119",
    address: { line1: "88 Canyon Ridge Ave", city: "Round Rock", region: "TX", postal: "78681" },
    stageKey: "connected",
    stageDaysAgo: 45,
    coach: "ruth",
    visitDaysAgo: [120, 113, 106, 92, 60],
    howHeard: "Online search",
    householdMembers: "Arjun Raman (spouse), two teenagers",
    interactions: [
      { kind: "email", daysAgo: 40, body: "Emailed the small group options closest to Canyon Ridge." },
      { kind: "note", daysAgo: 18, body: "Happy where she is — no follow-up needed this month." },
    ],
  },
  {
    firstName: "Tom",
    lastName: "Becker",
    email: "tom.becker@example.com",
    phone: "(512) 555-0177",
    stageKey: "first_time_guest",
    stageDaysAgo: 12,
    coach: "dana",
    visitDaysAgo: [19],
    howHeard: "A friend brought me",
    prayerRequest: "My mother is unwell.",
    interactions: [
      { kind: "text", daysAgo: 9, body: "Texted to welcome him and ask about his mother. No reply yet." },
    ],
  },
  {
    firstName: "Aisha",
    lastName: "Bello",
    email: "aisha.bello@example.com",
    phone: "(512) 555-0133",
    address: { line1: "2201 Oak Hollow Dr", city: "Austin", region: "TX", postal: "78727" },
    stageKey: "returning_guest",
    stageDaysAgo: 6,
    coach: "ruth",
    visitDaysAgo: [20, 13],
    howHeard: "Community event",
    children: "Zainab (4)",
    interactions: [
      { kind: "text", daysAgo: 4, body: "Told her about the next Growth Track start date." },
    ],
  },
  {
    firstName: "Jonah",
    lastName: "Kim",
    email: "jonah.kim@example.com",
    phone: "(512) 555-0155",
    address: { line1: "555 Meadow Ln", city: "Round Rock", region: "TX", postal: "78665" },
    stageKey: "growth_track_complete",
    stageDaysAgo: 45,
    coach: "dana",
    visitDaysAgo: [120, 113, 106, 60],
    howHeard: "My sister goes here",
    decisions: [{ type: "baptism", daysAgo: 99, notes: "Baptised at the fall service." }],
    steps: [
      { key: "growth_track_session_1", name: "Session 1 — Belonging", daysAgo: 60 },
      { key: "growth_track_session_2", name: "Session 2 — How you are shaped", daysAgo: 53 },
      { key: "growth_track_session_3", name: "Session 3 — Character", daysAgo: 46 },
      { key: "growth_track_session_4", name: "Session 4 — Your team", daysAgo: 39 },
    ],
    interactions: [
      { kind: "call", daysAgo: 30, body: "Called about joining a serve team. Said he would get back to us." },
      { kind: "note", daysAgo: 21, body: "Still not connected to a team. Needs a second ask, in person." },
    ],
  },
  {
    firstName: "Hannah",
    lastName: "Patel",
    email: "hannah.patel@example.com",
    phone: "(512) 555-0188",
    address: { line1: "9 Sycamore Ct", city: "Cedar Park", region: "TX", postal: "78613" },
    stageKey: "serving",
    stageDaysAgo: 60,
    coach: "ruth",
    visitDaysAgo: [200, 150, 100, 30],
    howHeard: "Grew up here",
    householdMembers: "Ravi Patel (spouse)",
    decisions: [{ type: "rededication", daysAgo: 150 }],
    steps: [
      { key: "growth_track_session_1", name: "Session 1 — Belonging", daysAgo: 120 },
      { key: "growth_track_session_2", name: "Session 2 — How you are shaped", daysAgo: 113 },
      { key: "growth_track_session_3", name: "Session 3 — Character", daysAgo: 106 },
      { key: "growth_track_session_4", name: "Session 4 — Your team", daysAgo: 99 },
      { key: "serve_team_orientation", name: "Serve team orientation", daysAgo: 60 },
    ],
    interactions: [
      { kind: "in_person", daysAgo: 30, body: "Caught up after the service — settled in her serve team." },
    ],
  },
  {
    firstName: "Luis",
    lastName: "Ortega",
    email: "luis.ortega@example.com",
    phone: "(512) 555-0121",
    address: { line1: "77 Prairie Wind Blvd", city: "Hutto", region: "TX", postal: "78634" },
    stageKey: "leading",
    stageDaysAgo: 100,
    coach: "dana",
    visitDaysAgo: [300, 200, 100],
    howHeard: "Been here for years",
    decisions: [
      { type: "salvation", daysAgo: 280 },
      { type: "baptism", daysAgo: 260 },
    ],
    interactions: [
      { kind: "note", daysAgo: 90, body: "Leading a table of three new leaders this season." },
    ],
  },
  {
    firstName: "Grace",
    lastName: "Lin",
    email: "grace.lin@example.com",
    phone: "(512) 555-0166",
    stageKey: "first_time_guest",
    stageDaysAgo: 3,
    coach: "ruth",
    visitDaysAgo: [4],
    howHeard: "Instagram",
    prayerRequest: "For my studies.",
  },
  {
    firstName: "Sam",
    lastName: "Whitfield",
    email: "sam.whitfield@example.com",
    phone: "(512) 555-0199",
    stageKey: "returning_guest",
    stageDaysAgo: 21,
    coach: "ruth",
    visitDaysAgo: [40, 33],
    howHeard: "My neighbour invited me",
    interactions: [
      { kind: "call", daysAgo: 20, body: "Called to say thank you for coming back. Line was busy." },
      { kind: "text", daysAgo: 11, body: "Sent the Growth Track dates again." },
    ],
  },
  {
    firstName: "Nia",
    lastName: "Johnson",
    email: "nia.johnson@example.com",
    phone: "(512) 555-0144",
    address: { line1: "3100 Bluebonnet Ln", city: "Austin", region: "TX", postal: "78704" },
    stageKey: "growth_track_enrolled",
    stageDaysAgo: 44,
    coach: "ruth",
    visitDaysAgo: [58, 51, 44],
    howHeard: "A friend from work",
    children: "Micah (2)",
    steps: [
      { key: "growth_track_session_1", name: "Session 1 — Belonging", daysAgo: 44 },
      { key: "growth_track_session_2", name: "Session 2 — How you are shaped", daysAgo: 37 },
    ],
    interactions: [
      { kind: "email", daysAgo: 20, body: "Emailed about childcare for the next two sessions. No reply." },
    ],
  },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error(
      [
        "DATABASE_URL is not set — nothing to seed.",
        "",
        "Set it in the environment (Settings → Secrets) and run this again:",
        "  DATABASE_URL=postgres://user:password@host:5432/database bun run db:seed",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  const reset = process.argv.includes("--reset");
  const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 10_000 });
  const probe = await pool.connect();
  try {
    const { rows } = await probe.query<{ version: string }>("select version() as version");
    console.log(`Target: ${new URL(url).hostname}${new URL(url).pathname}`);
    console.log(`Server: ${rows[0].version.split(" on ")[0]}`);
    const { rows: migrated } = await probe.query<{ count: string }>(
      `select count(*)::text as count from information_schema.tables
        where table_schema = 'public' and table_name = 'persons'`,
    );
    if (migrated[0].count === "0") {
      console.error("\nThe schema is not applied yet. Run: bun run db:migrate");
      process.exitCode = 1;
      return;
    }
  } finally {
    probe.release();
    await pool.end();
  }

  const before = await withClient(async (client) =>
    (await client.query<{ id: string }>(`select id from churches where slug = $1`, [DEMO_SLUG])).rows.length,
  );
  if (before > 0 && !reset) {
    console.log(
      `\nThe demo church (${DEMO_SLUG}) is already seeded. Nothing changed.\nPass --reset to delete and rebuild it:  bun run db:seed -- --reset`,
    );
    return;
  }

  // ---- Checkpoint rule self-test ------------------------------------------
  await runCheckpointRuleSelfTest();

  // ---- The seed itself -----------------------------------------------------
  const summary = await withTransaction(async (client) => {
    if (reset) {
      await client.query(`delete from churches where slug = $1`, [DEMO_SLUG]);
      console.log("\nRemoved the previous demo church (cascade).");
    }

    const church = (
      await client.query<{ id: string }>(
        `insert into churches (name, slug, timezone) values ($1, $2, $3) returning id`,
        ["Demo Community Church", DEMO_SLUG, "America/Chicago"],
      )
    ).rows[0];

    const staff = (
      await client.query<{ id: string }>(
        `insert into staff_users (church_id, email, email_lower, name, role, password_hash, password_set_at)
         values ($1, $2, $3, $4, $5, $6, now()) returning id`,
        [
          church.id,
          "pastor@demo.church",
          "pastor@demo.church",
          "Dana Reyes",
          "owner",
          hashPassword(DEMO_PASSWORD),
        ],
      )
    ).rows[0];

    // A second staff member with the coach role: the task list's "my people" filter
    // needs somebody to be somebody else's coach.
    const coach = (
      await client.query<{ id: string }>(
        `insert into staff_users (church_id, email, email_lower, name, role, password_hash, password_set_at)
         values ($1, $2, $3, $4, $5, $6, now()) returning id`,
        [
          church.id,
          "coach@demo.church",
          "coach@demo.church",
          "Ruth Osei",
          "coach",
          hashPassword(DEMO_PASSWORD),
        ],
      )
    ).rows[0];

    const staffByKey = new Map<string, string>([
      ["dana", staff.id],
      ["ruth", coach.id],
    ]);

    const config = (
      await client.query<{ id: string }>(
        `insert into growth_track_configs (church_id, name, is_active, validated_at)
         values ($1, $2, true, now()) returning id`,
        [church.id, "Growth Track"],
      )
    ).rows[0];

    const stageByKey = new Map<string, string>();
    for (const stage of STAGES) {
      const row = (
        await client.query<{ id: string }>(
          `insert into growth_track_stages
             (church_id, config_id, key, name, description, sequence, expected_dwell_days, is_terminal, checkpoint_kind)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
          [
            church.id,
            config.id,
            stage.key,
            stage.name,
            stage.description,
            stage.sequence,
            stage.expectedDwellDays,
            stage.isTerminal,
            stage.checkpointKind,
          ],
        )
      ).rows[0];
      stageByKey.set(stage.key, row.id);
    }

    const validation = await client.query<{ is_valid: boolean; errors: string[] }>(
      `select is_valid, errors from validate_growth_track_config($1)`,
      [config.id],
    );
    if (!validation.rows[0]?.is_valid) {
      throw new Error(`seeded track fails the checkpoint rules: ${validation.rows[0]?.errors.join("; ")}`);
    }

    let households = 0;
    let visits = 0;
    let decisions = 0;
    let steps = 0;
    let interactions = 0;

    for (const spec of PEOPLE) {
      const emailLower = normalizeEmailLower(spec.email);
      const phoneE164 = normalizePhoneE164(spec.phone);
      const addressNormalized = spec.address
        ? normalizeAddress({
            addressLine1: spec.address.line1,
            city: spec.address.city,
            region: spec.address.region,
            postalCode: spec.address.postal,
          })
        : null;

      let householdId: string | null = null;
      if (addressNormalized) {
        const existing = await client.query<{ id: string }>(
          `select id from households where church_id = $1 and address_normalized = $2`,
          [church.id, addressNormalized],
        );
        if (existing.rows.length > 0) {
          householdId = existing.rows[0].id;
        } else {
          householdId = (
            await client.query<{ id: string }>(
              `insert into households
                 (church_id, name, address_line1, city, region, postal_code, address_normalized, phone_e164)
               values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
              [
                church.id,
                householdName(spec.lastName),
                spec.address?.line1 ?? null,
                spec.address?.city ?? null,
                spec.address?.region ?? null,
                spec.address?.postal ?? null,
                addressNormalized,
                phoneE164,
              ],
            )
          ).rows[0].id;
          households += 1;
        }
      }

      const person = (
        await client.query<{ id: string }>(
          `insert into persons
             (church_id, household_id, first_name, last_name, email, email_lower, phone, phone_e164,
              name_normalized, address_normalized, assigned_coach_user_id, created_via)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'import') returning id`,
          [
            church.id,
            householdId,
            spec.firstName,
            spec.lastName,
            spec.email,
            emailLower,
            spec.phone,
            phoneE164,
            normalizeName(spec.firstName, spec.lastName),
            addressNormalized,
            staffByKey.get(spec.coach) ?? null,
          ],
        )
      ).rows[0];

      // Visits, oldest first, so visit_number matches the real order.
      const ordered = [...spec.visitDaysAgo].sort((a, b) => b - a);
      for (const [index, days] of ordered.entries()) {
        await client.query(
          `insert into person_visits (church_id, person_id, visit_number, attended_at, source, note)
           values ($1, $2, $3, $4, 'connect_card', $5)`,
          [church.id, person.id, index + 1, daysAgo(days), index === 0 ? "First recorded visit" : null],
        );
        visits += 1;
      }

      // Stage placement. The entry time is what the dwell clock counts from, so it is
      // set to an exact number of days ago — that is what makes the demo show a real
      // task list (people past their stage's expected dwell) on first load, rather
      // than a board where everybody is either brand new or uniformly overdue.
      await client.query(
        `select set_person_stage($1, $2, $3, $4, 'migration', $5)`,
        [
          person.id,
          stageByKey.get(spec.stageKey) ?? null,
          staffByKey.get(spec.coach) ?? staff.id,
          `Seeded at ${spec.stageKey} from visit history`,
          exactDaysAgo(spec.stageDaysAgo),
        ],
      );

      for (const decision of spec.decisions ?? []) {
        await client.query(
          `insert into decision_events
             (church_id, person_id, event_type, occurred_at, recorded_at, stage_id_at_event, source, notes, recorded_by_staff_id)
           values ($1, $2, $3, $4, $5, $6, 'staff_entry', $7, $8)`,
          [
            church.id,
            person.id,
            decision.type,
            daysAgo(decision.daysAgo),
            daysAgo(decision.daysAgo),
            stageByKey.get(spec.stageKey) ?? null,
            decision.notes ?? null,
            staff.id,
          ],
        );
        decisions += 1;
      }

      for (const step of spec.steps ?? []) {
        await client.query(
          `insert into step_completions
             (church_id, person_id, stage_id, step_key, step_name, completed_at, source, completed_by_staff_id)
           values ($1, $2, $3, $4, $5, $6, 'staff_entry', $7)`,
          [
            church.id,
            person.id,
            stageByKey.get(spec.stageKey) ?? null,
            step.key,
            step.name,
            daysAgo(step.daysAgo),
            staff.id,
          ],
        );
        steps += 1;
      }

      // The contact log. These are the only rows that make "last contact" meaningful
      // on the board and the task list; persons.last_contact_at is maintained by the
      // trigger in migration 0003, so nothing here sets it by hand.
      for (const interaction of spec.interactions ?? []) {
        await client.query(
          `insert into person_interactions (church_id, person_id, staff_user_id, kind, occurred_at, body)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            church.id,
            person.id,
            staffByKey.get(spec.coach) ?? staff.id,
            interaction.kind,
            exactDaysAgo(interaction.daysAgo, 14),
            interaction.body ?? null,
          ],
        );
        interactions += 1;
      }
    }

    // ---- Two arrivals through the real capture path -----------------------
    const peopleBefore = await countPeople(client, church.id);

    const brandNew = await resolveConnectCard(client, church.id, {
      firstName: "Elena",
      lastName: "Fischer",
      email: "elena.fischer@example.com",
      phone: "(512) 555-0201",
      addressLine1: "18 Cardinal Way",
      city: "Round Rock",
      region: "TX",
      postalCode: "78681",
      visitReport: "first_time",
      howHeard: "Neighbour across the street",
      prayerRequest: "Settling into a new city.",
      householdMembers: "Peter Fischer (spouse)",
      attendedAt: daysAgo(0, 16),
      source: "connect_card",
    });

    const returning = await resolveConnectCard(client, church.id, {
      firstName: "Grace",
      lastName: "Lin",
      email: "grace.lin@example.com",
      // Same phone number as the seeded Grace Lin: this must land on her record.
      phone: "(512) 555-0166",
      visitReport: "returning",
      howHeard: "Instagram",
      attendedAt: daysAgo(0, 16),
      source: "connect_card",
    });

    const peopleAfter = await countPeople(client, church.id);
    const duplicates = await client.query<{ phone_e164: string; count: string }>(
      `select phone_e164, count(*)::text as count from persons
        where church_id = $1 and phone_e164 is not null
        group by phone_e164 having count(*) > 1`,
      [church.id],
    );

    const check = {
      brandNew,
      returning,
      peopleBefore,
      peopleAfter,
      duplicates: duplicates.rows,
    };

    if (check.brandNew.personCreated !== true) throw new Error("identity check: new guest was not created");
    if (check.brandNew.visitNumber !== 1) throw new Error("identity check: new guest is not visit #1");
    if (check.returning.personCreated !== false) {
      throw new Error("identity check: returning guest created a duplicate person");
    }
    if (check.returning.matchedOn !== "phone_e164") {
      throw new Error(`identity check: returning guest matched on ${check.returning.matchedOn}`);
    }
    if (check.returning.visitNumber !== 2) {
      throw new Error(`identity check: returning guest recorded visit #${String(check.returning.visitNumber)}`);
    }
    if (check.peopleAfter !== check.peopleBefore + 1) {
      throw new Error(
        `identity check: person count went from ${String(check.peopleBefore)} to ${String(check.peopleAfter)} for one new guest`,
      );
    }
    if (check.duplicates.length > 0) {
      throw new Error(`identity check: duplicate phone numbers: ${JSON.stringify(check.duplicates)}`);
    }

    return {
      churchId: church.id,
      staffEmail: "pastor@demo.church",
      households,
      visits,
      decisions,
      steps,
      interactions,
      check,
    };
  });

  // ---- Report -------------------------------------------------------------
  const report = await withClient(async (client) => {
    const byStage = await client.query<{ name: string; sequence: number; people: string }>(
      `select s.name, s.sequence, count(p.id)::text as people
         from growth_track_stages s
         left join persons p on p.current_stage_id = s.id
        where s.church_id = $1
        group by s.id order by s.sequence`,
      [summary.churchId],
    );
    const totalsResult = await client.query<{
      people: string;
      visits: string;
      second_visits: string;
      decisions: string;
      steps: string;
      history: string;
      submissions: string;
      flagged: string;
      interactions: string;
      overdue: string;
    }>(
      `select
         (select count(*)::text from persons where church_id = $1) as people,
         (select count(*)::text from person_visits where church_id = $1) as visits,
         (select count(*)::text from person_visits where church_id = $1 and visit_number = 2) as second_visits,
         (select count(*)::text from decision_events where church_id = $1) as decisions,
         (select count(*)::text from step_completions where church_id = $1) as steps,
         (select count(*)::text from stage_history where church_id = $1) as history,
         (select count(*)::text from connect_card_submissions where church_id = $1) as submissions,
         (select count(*)::text from persons where church_id = $1 and review_flag is not null) as flagged,
         (select count(*)::text from person_interactions where church_id = $1) as interactions,
         (select count(*)::text from persons p join person_stage_clock c on c.person_id = p.id
           where p.church_id = $1 and c.days_overdue > 0) as overdue`,
      [summary.churchId],
    );
    const overdueRows = await client.query<{
      full_name: string;
      stage_name: string;
      days_in_stage: number;
      expected_dwell_days: number;
      days_overdue: number;
      coach: string | null;
    }>(
      `select p.full_name, c.stage_name, c.days_in_stage, c.expected_dwell_days, c.days_overdue,
              (select name from staff_users u where u.id = p.assigned_coach_user_id) as coach
         from persons p
         join person_stage_clock c on c.person_id = p.id
        where p.church_id = $1 and c.days_overdue > 0
        order by c.days_overdue desc, p.full_name`,
      [summary.churchId],
    );
    return { byStage: byStage.rows, totals: totalsResult.rows[0], overdueRows: overdueRows.rows };
  });

  console.log("\nSeeded:");
  console.log(`  church            Demo Community Church (${DEMO_SLUG})`);
  console.log(`  staff sign-in     ${summary.staffEmail}  /  ${DEMO_PASSWORD}`);
  console.log(`  coach sign-in     coach@demo.church  /  ${DEMO_PASSWORD}  (role: coach)`);
  console.log(`  stages            ${String(STAGES.length)} (checkpoint rules validated)`);
  console.log(`  households        ${String(summary.households)}`);
  console.log(`  people            ${report.totals.people}`);
  console.log(`  visits            ${report.totals.visits} (${report.totals.second_visits} of them second visits)`);
  console.log(`  decisions         ${report.totals.decisions} (repeatable, timestamped, separate from stage)`);
  console.log(`  step completions  ${report.totals.steps}`);
  console.log(`  stage history     ${report.totals.history} rows`);
  console.log(`  contact log       ${report.totals.interactions} interactions`);
  console.log(`  connect cards     ${report.totals.submissions}`);
  console.log(`  flagged for review ${report.totals.flagged}`);
  console.log("\nPeople by stage:");
  for (const row of report.byStage) {
    console.log(`  ${String(row.sequence)}. ${row.name.padEnd(22)} ${row.people}`);
  }

  console.log(`\nStall detection (derived, not stored) — ${report.totals.overdue} people overdue:`);
  for (const row of report.overdueRows) {
    console.log(
      `  ${row.full_name.padEnd(18)} ${row.stage_name.padEnd(22)} ${String(row.days_in_stage).padStart(3)} days in stage, expected ${String(row.expected_dwell_days).padStart(3)} → ${String(row.days_overdue).padStart(2)} days over (coach: ${row.coach ?? "none"})`,
    );
  }

  console.log("\nIdentity check (through the real connect-card path):");
  console.log(
    `  new guest        Elena Fischer -> created=${String(summary.check.brandNew.personCreated)} visit #${String(summary.check.brandNew.visitNumber)}`,
  );
  console.log(
    `  returning guest  Grace Lin    -> matched on ${summary.check.returning.matchedOn}, visit #${String(summary.check.returning.visitNumber)}, created=${String(summary.check.returning.personCreated)}`,
  );
  console.log(
    `  person count     ${String(summary.check.peopleBefore)} -> ${String(summary.check.peopleAfter)} (one new guest, no duplicate)`,
  );
  console.log(
    `  next step shown  "${summary.check.returning.nextStep.title}" for the returning guest`,
  );
  console.log("\nDone. Sign in at /login as pastor@demo.church, then open /staff/pipeline,");
  console.log("/staff/tasks (the overdue coach list) and /staff/people.");
}

async function countPeople(client: PoolClient, churchId: string): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `select count(*)::text as count from persons where church_id = $1`,
    [churchId],
  );
  return Number(rows[0].count);
}

/**
 * Prove the checkpoint rules actually bite: build a deliberately broken track
 * (deployment first, self-understanding after, belonging missing) and check that
 * validate_growth_track_config() refuses it. Everything here is rolled back.
 */
async function runCheckpointRuleSelfTest(): Promise<void> {
  class Rollback extends Error {}
  try {
    await withTransaction(async (client) => {
      const church = (
        await client.query<{ id: string }>(
          `insert into churches (name, slug) values ($1, $2) returning id`,
          ["__rule_test__", "__rule_test__"],
        )
      ).rows[0];
      const config = (
        await client.query<{ id: string }>(
          `insert into growth_track_configs (church_id, name) values ($1, $2) returning id`,
          [church.id, "Broken track"],
        )
      ).rows[0];
      await client.query(
        `insert into growth_track_stages (church_id, config_id, key, name, sequence, checkpoint_kind)
         values ($1, $2, 'deployment', 'Deployed first', 1, 'deployment'),
                ($1, $2, 'self', 'Self-understanding second', 2, 'self_understanding')`,
        [church.id, config.id],
      );
      const { rows } = await client.query<{ is_valid: boolean; errors: string[] }>(
        `select is_valid, errors from validate_growth_track_config($1)`,
        [config.id],
      );
      if (rows[0].is_valid) {
        throw new Error(
          "checkpoint rules are NOT enforced: the validator accepted a track with deployment first, self-understanding second and no belonging checkpoint",
        );
      }
      console.log("\nCheckpoint rule check: the validator refused a broken track, as it must:");
      for (const error of rows[0].errors) console.log(`  - ${error}`);
      throw new Rollback("rollback");
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

main()
  .catch((err: unknown) => {
    if (err instanceof DbUnavailableError) {
      console.error(`\nDatabase unavailable (${err.reason}): ${err.message}`);
    } else {
      console.error("\nSeed failed — the transaction was rolled back; nothing partial was kept.");
      console.error(err instanceof Error ? err.message : err);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
