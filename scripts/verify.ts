// End-to-end check of the data path against a real database.
//
//   DATABASE_URL=... bun run db:verify
//
// It is deliberately read-only with respect to the demo data: the one part that has
// to write (driving a returning guest through identity resolution) runs inside a
// transaction that is rolled back, so verifying never leaves a trace.
//
// What it proves, in order:
//   1. the connection works and the spine schema is present
//   2. the seeded church / staff / stages / people are actually there
//   3. staff sign-in works: correct password opens a session, a wrong one does not,
//      and signing out really revokes it (this is the code the /staff guard uses)
//   4. the people list and dashboard queries the UI runs return real rows
//   5. identity resolution still refuses to duplicate a returning guest
//   6. the pipeline board and coach task list (slice 2): the board reads the church's
//      own stages, stall detection finds a real overdue list, moving somebody writes
//      a stage_history row and restarts the dwell clock, and logging a contact writes
//      an interaction without moving anyone (all inside a rolled-back transaction)
//   7. the read-only person record returns every part of one person's history

import { closePool, checkDatabase, query, withTransaction } from "../src/lib/pg";
import { hashPassword } from "../src/lib/auth";
import { readStaffSession, requireStaff, revokeSession, signInWithPassword } from "../src/server/auth-core";
import {
  COACH_TASKS_SQL,
  PIPELINE_CARDS_SQL,
  fetchCoachTasks,
  fetchDashboard,
  fetchPeople,
  fetchPersonRecord,
  fetchPipeline,
} from "../src/server/queries";
import { resolveConnectCard } from "../src/server/identity";

const DEMO_EMAIL = "pastor@demo.church";
const DEMO_PASSWORD = process.env.SEED_STAFF_PASSWORD?.trim() || "growthtrack-demo";

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
}

class Rollback extends Error {}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) {
    console.error("DATABASE_URL is not set — nothing to verify.");
    process.exitCode = 1;
    return;
  }

  const health = await checkDatabase();
  console.log(`Target: ${health.host ?? "?"}/${health.database ?? "?"}`);
  console.log(`Server: ${health.serverVersion?.split(" on ")[0] ?? "?"}\n`);

  console.log("Schema");
  check("database reachable", health.reachable, health.error?.message);
  check(
    `all ${String(health.expectedTables)} spine tables present`,
    health.migrated,
    `${String(health.migratedTables)}/${String(health.expectedTables)}`,
  );
  check("migrations recorded", (health.appliedMigrations?.length ?? 0) > 0, (health.appliedMigrations ?? []).join(", "));

  if (!health.reachable || !health.migrated) {
    console.log("\nCannot go further without a migrated database.");
    return;
  }

  console.log("\nSeeded data");
  const [counts] = await query<{
    churches: string;
    staff: string;
    stages: string;
    persons: string;
    visits: string;
    second_visits: string;
    decisions: string;
    steps: string;
    history: string;
    submissions: string;
    church_id: string;
    church_name: string;
  }>(
    `select
       (select count(*) from churches) as churches,
       (select count(*) from staff_users) as staff,
       (select count(*) from growth_track_stages) as stages,
       (select count(*) from persons) as persons,
       (select count(*) from person_visits) as visits,
       (select count(*) from person_visits where visit_number = 2) as second_visits,
       (select count(*) from decision_events) as decisions,
       (select count(*) from step_completions) as steps,
       (select count(*) from stage_history) as history,
       (select count(*) from connect_card_submissions) as submissions,
       (select id from churches order by created_at asc limit 1) as church_id,
       (select name from churches order by created_at asc limit 1) as church_name`,
  );
  for (const [label, value] of [
    ["churches", counts.churches],
    ["staff accounts", counts.staff],
    ["stages", counts.stages],
    ["people", counts.persons],
    ["visits", counts.visits],
    ["second visits", counts.second_visits],
    ["decision events", counts.decisions],
    ["step completions", counts.steps],
    ["stage history rows", counts.history],
    ["connect card submissions", counts.submissions],
  ] as const) {
    check(`${label} present`, Number(value) > 0, value);
  }

  console.log("\nStaff sign-in (the code path behind the /staff guard)");
  const good = await signInWithPassword(DEMO_EMAIL, DEMO_PASSWORD, { userAgent: "verify-script" });
  check("correct password opens a session", good.ok, good.ok ? "" : good.message);
  if (!good.ok) return;

  const session = await readStaffSession(good.token);
  check("session resolves to a signed-in staff user", session.state === "signed-in");
  if (session.state === "signed-in") {
    check("session carries the church", session.churchName.length > 0, `${session.name} @ ${session.churchName}`);
  }
  check("no token means signed out", (await readStaffSession(null)).state === "signed-out");
  const guarded = await requireStaff(good.token);
  check("requireStaff() admits a valid session", guarded.ok);

  const bad = await signInWithPassword(DEMO_EMAIL, `${DEMO_PASSWORD}-wrong`, { userAgent: "verify-script" });
  check("wrong password is refused", !bad.ok, bad.ok ? "" : bad.message);
  const unknown = await signInWithPassword("nobody@example.com", "whatever12345", { userAgent: "verify-script" });
  check("unknown email is refused", !unknown.ok, unknown.ok ? "" : unknown.message);

  await revokeSession(good.token);
  check("signing out revokes the session", (await readStaffSession(good.token)).state === "signed-out");

  console.log("\nThe queries the staff screens run");
  const withQuery = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await query<T>(text, params)) as T[];
  const people = await fetchPeople(withQuery, counts.church_id);
  check("people list returns rows", people.people.length > 0, `${String(people.people.length)} rows`);
  check(
    "people list carries stage + visit facts",
    people.people.every((p) => p.stageName !== null && typeof p.visitCount === "number"),
  );
  check(
    "returning people are visible as such",
    people.people.some((p) => p.visitCount >= 2 && p.visitStatus === "returning"),
  );
  check("summary counts line up with the rows", people.summary.people === people.people.length);

  const dashboard = await fetchDashboard(withQuery, counts.church_id, counts.church_name);
  check("dashboard returns the seven stages", dashboard.stages.length === 7, `${String(dashboard.stages.length)} stages`);
  const byName = new Map(dashboard.stages.map((s) => [s.name, s]));
  check("stage order is First-Time Guest → Leading", dashboard.stages[0]?.name === "First-Time Guest" && dashboard.stages[6]?.name === "Leading");
  check(
    "every stage that must know its dwell time does",
    dashboard.stages.filter((s) => !s.isTerminal).every((s) => typeof s.expectedDwellDays === "number"),
  );
  check("the database agrees the track satisfies the checkpoint rules", dashboard.checkpoints?.is_valid === true, (dashboard.checkpoints?.errors ?? []).join("; "));
  check("dashboard totals agree with the people count", dashboard.totals.people === Number(counts.persons));
  check(
    "people are spread across stages, not all in one",
    new Set(dashboard.stages.filter((s) => s.people > 0).map((s) => s.name)).size >= 4,
    dashboard.stages.map((s) => `${s.name}:${String(s.people)}`).join(" "),
  );
  console.log(
    `       first row: ${people.people[0]?.fullName} — ${String(people.people[0]?.stageName)}, ${String(people.people[0]?.visitCount)} visit(s), last contact ${String(people.people[0]?.lastContactOn)}`,
  );

  console.log("\nIdentity resolution for a returning guest (rolled back afterwards)");
  const phone = `(512) 555-${String(1000 + Math.floor(Math.random() * 8999))}`;
  try {
    await withTransaction(async (client) => {
      const before = Number(
        (await client.query<{ count: string }>(`select count(*)::text as count from persons where church_id = $1`, [counts.church_id])).rows[0].count,
      );
      const first = await resolveConnectCard(client, counts.church_id, {
        firstName: "Verify",
        lastName: "Probe",
        email: "verify.probe@example.com",
        phone,
        addressLine1: "1 Verification Way",
        city: "Round Rock",
        region: "TX",
        postalCode: "78664",
        visitReport: "first_time",
        source: "connect_card",
      });
      check("a brand-new guest becomes a new person, visit #1", first.personCreated && first.visitNumber === 1);

      const second = await resolveConnectCard(client, counts.church_id, {
        firstName: "Verify",
        lastName: "Probe",
        phone,
        visitReport: "returning",
        source: "connect_card",
      });
      check(
        "the same phone number matches on phone_e164",
        second.matchedOn === "phone_e164",
        `matched on ${second.matchedOn}`,
      );
      check("no second person record is created", second.personCreated === false);
      check("the second visit lands as visit #2", second.visitNumber === 2, `visit #${String(second.visitNumber)}`);
      check(
        "the person is told their next step",
        second.nextStep.title.startsWith("Next step:"),
        second.nextStep.title,
      );

      const after = Number(
        (await client.query<{ count: string }>(`select count(*)::text as count from persons where church_id = $1`, [counts.church_id])).rows[0].count,
      );
      check("one new guest produced exactly one new record", after === before + 1, `${String(before)} → ${String(after)}`);

      const dupes = await client.query<{ phone_e164: string; count: string }>(
        `select phone_e164, count(*)::text as count from persons
          where church_id = $1 and phone_e164 is not null
          group by phone_e164 having count(*) > 1`,
        [counts.church_id],
      );
      check("no phone number is attached to two people", dupes.rows.length === 0, JSON.stringify(dupes.rows));

      throw new Rollback("verify: roll back probe data");
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  check(
    "probe data was rolled back",
    Number((await query<{ count: string }>(`select count(*) from persons where church_id = $1`, [counts.church_id]))[0].count) ===
      Number(counts.persons),
  );

  console.log("\nPipeline board and stall detection (slice 2)");
  const board = await fetchPipeline(withQuery, counts.church_id, counts.church_name);
  const boardCards = board.columns.flatMap((column) => column.cards);
  check(
    "board columns are this church's own stages, in order",
    board.columns.length === 7 && board.columns[0]?.name === "First-Time Guest",
    board.columns.map((c) => c.name).join(" → "),
  );
  check(
    "every stage that sets an expectation shows it on the column",
    board.columns.filter((c) => !c.isTerminal).every((c) => typeof c.expectedDwellDays === "number"),
  );
  const cardRowCount = Number(
    (await query<{ count: string }>(`select count(*)::text as count from (${PIPELINE_CARDS_SQL}) x`, [counts.church_id]))[0]
      .count,
  );
  check(
    "one card per person on the track",
    boardCards.length === cardRowCount && boardCards.length === Number(counts.persons),
    `${String(boardCards.length)} cards / ${String(counts.persons)} people`,
  );
  check(
    "every card carries visit facts, a stage clock and a last contact",
    boardCards.every(
      (c) =>
        typeof c.visitCount === "number" &&
        c.visitStatus !== undefined &&
        typeof c.daysInStage === "number" &&
        "lastContactOn" in c,
    ),
  );
  check(
    "cards distinguish first-time guests from returning people",
    boardCards.some((c) => c.visitStatus === "first-time") &&
      boardCards.some((c) => c.visitStatus === "returning"),
    boardCards.map((c) => `${c.fullName}:${c.visitStatus}`).join(" "),
  );
  check(
    "every card past its stage's dwell is marked overdue, and no other card is",
    boardCards.every((c) =>
      c.expectedDwellDays === null
        ? c.daysOverdue === null && !c.isOverdue
        : c.isOverdue === (c.daysInStage > c.expectedDwellDays),
    ),
    boardCards
      .filter((c) => c.isOverdue)
      .map((c) => `${c.fullName}+${String(c.daysOverdue)}`)
      .join(" "),
  );
  check(
    "the overdue count on the board agrees with the cards",
    board.overdueCount === boardCards.filter((c) => c.isOverdue).length,
    `${String(board.overdueCount)} overdue`,
  );
  check(
    "the seeded demo has a real task list on first load",
    board.overdueCount >= 3 &&
      new Set(boardCards.filter((c) => c.isOverdue).map((c) => c.stageName)).size >= 3,
    `${String(board.overdueCount)} overdue across ${String(new Set(boardCards.filter((c) => c.isOverdue).map((c) => c.stageName)).size)} stages`,
  );

  const [owner] = await query<{ id: string; name: string }>(
    `select id, name from staff_users where email_lower = $1`,
    [DEMO_EMAIL],
  );
  const allTasks = await fetchCoachTasks(
    withQuery,
    { churchId: counts.church_id, staffUserId: owner.id, name: owner.name, churchName: counts.church_name },
    "all",
  );
  check(
    "the task list is exactly the overdue people",
    allTasks.tasks.length === board.overdueCount && allTasks.overdueAll === board.overdueCount,
    `${String(allTasks.tasks.length)} rows`,
  );
  check(
    "every task row is genuinely past its expected dwell",
    allTasks.tasks.every((t) => t.daysInStage > t.expectedDwellDays && t.daysOverdue === t.daysInStage - t.expectedDwellDays),
  );
  check(
    "the list is sorted most overdue first",
    allTasks.tasks.every((t, i) => i === 0 || allTasks.tasks[i - 1].daysOverdue >= t.daysOverdue),
    allTasks.tasks.map((t) => `${t.fullName}:${String(t.daysOverdue)}`).join(" "),
  );
  const mineTasks = await fetchCoachTasks(
    withQuery,
    { churchId: counts.church_id, staffUserId: owner.id, name: owner.name, churchName: counts.church_name },
    "mine",
  );
  check(
    "'my people' filters on the assigned coach and is a strict subset",
    mineTasks.tasks.length > 0 &&
      mineTasks.tasks.length <= allTasks.tasks.length &&
      mineTasks.tasks.every((t) => t.assignedCoachUserId === owner.id),
    `${String(mineTasks.tasks.length)} of ${String(allTasks.tasks.length)} assigned to ${owner.name}`,
  );
  check(
    "the like-for-like SQL behind the list returns the same rows",
    Number((await query<{ count: string }>(`select count(*)::text as count from (${COACH_TASKS_SQL}) x`, [counts.church_id, null]))[0].count) ===
      allTasks.tasks.length,
  );
  console.log(
    `       worst: ${allTasks.tasks[0]?.fullName} — ${String(allTasks.tasks[0]?.daysInStage)} days in ${allTasks.tasks[0]?.stageName} (expected ${String(allTasks.tasks[0]?.expectedDwellDays)})`,
  );

  console.log("\nMoving somebody and logging a contact (rolled back afterwards)");
  const probeTarget = allTasks.tasks[0];
  const probeStateBefore = (
    await query<{ current_stage_id: string; interactions: string }>(
      `select p.current_stage_id,
              (select count(*)::text from person_interactions where person_id = p.id) as interactions
         from persons p where p.id = $1`,
      [probeTarget.id],
    )
  )[0];
  const probeCandidates = await query<{ id: string; name: string; sequence: number }>(
    `select id, name, sequence from growth_track_stages where church_id = $1 order by sequence`,
    [counts.church_id],
  );
  try {
    await withTransaction(async (client) => {
      const txQuery = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
        (await client.query<T>(text, params)).rows as T[];
      const session = {
        churchId: counts.church_id,
        staffUserId: owner.id,
        name: owner.name,
        churchName: counts.church_name,
      };

      const beforeRow = (
        await client.query<{ current_stage_id: string; stage_changed_at: Date }>(
          `select current_stage_id, stage_changed_at from persons where id = $1`,
          [probeTarget.id],
        )
      ).rows[0];

      // ---- logging a contact ------------------------------------------------
      await client.query(
        `insert into person_interactions (church_id, person_id, staff_user_id, kind, occurred_at, body)
         values ($1, $2, $3, 'call', now(), 'verify probe: outreach logged')`,
        [counts.church_id, probeTarget.id, owner.id],
      );
      const afterLog = (
        await client.query<{ current_stage_id: string; stage_changed_at: Date; last_contact_at: Date }>(
          `select current_stage_id, stage_changed_at, last_contact_at from persons where id = $1`,
          [probeTarget.id],
        )
      ).rows[0];
      check(
        "logging a contact does NOT move the person's stage",
        afterLog.current_stage_id === beforeRow.current_stage_id,
      );
      check(
        "logging a contact does NOT restart the dwell clock",
        new Date(afterLog.stage_changed_at).getTime() === new Date(beforeRow.stage_changed_at).getTime(),
      );
      check(
        "the contact row is recorded and 'last contact' is derived from it",
        new Date(afterLog.last_contact_at).getTime() > Date.now() - 60_000,
        `last contact ${new Date(afterLog.last_contact_at).toISOString()}`,
      );
      const loggedTasks = await fetchCoachTasks(txQuery, session, "all");
      const loggedRow = loggedTasks.tasks.find((t) => t.id === probeTarget.id);
      check(
        "the task list shows the new contact but the same overdue count",
        loggedRow !== undefined &&
          loggedRow.daysOverdue === probeTarget.daysOverdue &&
          Number(loggedTasks.overdueAll) === allTasks.overdueAll,
        `${String(loggedRow?.daysOverdue)} days over, last contact ${String(loggedRow?.lastContactOn)}`,
      );

      // ---- moving somebody --------------------------------------------------
      const currentIndex = probeCandidates.findIndex((s) => s.id === beforeRow.current_stage_id);
      const destination = probeCandidates[currentIndex + 1] ?? probeCandidates[0];
      const historyBefore = Number(
        (await client.query<{ count: string }>(
          `select count(*)::text as count from stage_history where person_id = $1`,
          [probeTarget.id],
        )).rows[0].count,
      );
      await client.query(`select set_person_stage($1, $2, $3, $4, 'staff_entry')`, [
        probeTarget.id,
        destination.id,
        owner.id,
        "verify: move probe",
      ]);

      const moved = (
        await client.query<{
          current_stage_id: string;
          stage_changed_at: Date;
          days_in_stage: number;
          days_overdue: number | null;
        }>(
          `select p.current_stage_id, p.stage_changed_at, c.days_in_stage, c.days_overdue
             from persons p join person_stage_clock c on c.person_id = p.id
            where p.id = $1`,
          [probeTarget.id],
        )
      ).rows[0];
      check("the move lands the person in the new stage", moved.current_stage_id === destination.id, destination.name);
      check(
        "the dwell clock restarted at the move (days in stage is 0 again)",
        moved.days_in_stage === 0 &&
          new Date(moved.stage_changed_at).getTime() > Date.now() - 60_000,
      );
      check(
        "the person drops off the task list until the new stage's dwell is exceeded",
        moved.days_overdue === null || moved.days_overdue <= 0,
        `days overdue: ${String(moved.days_overdue)}`,
      );

      const historyRow = (
        await client.query<{
          from_stage_id: string;
          to_stage_id: string;
          changed_by_staff_id: string;
          reason: string;
          source: string;
          changed_at: Date;
        }>(
          `select from_stage_id, to_stage_id, changed_by_staff_id, reason, source, changed_at
             from stage_history where person_id = $1 order by changed_at desc, created_at desc limit 1`,
          [probeTarget.id],
        )
      ).rows[0];
      const historyAfter = Number(
        (await client.query<{ count: string }>(
          `select count(*)::text as count from stage_history where person_id = $1`,
          [probeTarget.id],
        )).rows[0].count,
      );
      check("the move wrote a stage_history row", historyAfter === historyBefore + 1);
      check(
        "that row records from, to, who and when",
        historyRow.from_stage_id === beforeRow.current_stage_id &&
          historyRow.to_stage_id === destination.id &&
          historyRow.changed_by_staff_id === owner.id &&
          historyRow.source === "staff_entry" &&
          new Date(historyRow.changed_at).getTime() > Date.now() - 60_000,
      );

      throw new Rollback("verify: roll back the move + contact probes");
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  const reverted = (
    await query<{ current_stage_id: string; interactions: string }>(
      `select p.current_stage_id,
              (select count(*)::text from person_interactions where person_id = p.id) as interactions
         from persons p where p.id = $1`,
      [probeTarget.id],
    )
  )[0];
  check(
    "the move and contact probes were rolled back",
    reverted.current_stage_id === probeStateBefore.current_stage_id &&
      reverted.interactions === probeStateBefore.interactions,
    `stage ${reverted.current_stage_id === probeStateBefore.current_stage_id ? "unchanged" : "CHANGED"}, ` +
      `${reverted.interactions} interaction(s) still on the record`,
  );

  console.log("\nRecording a decision event never moves the person (rolled back afterwards)");
  try {
    await withTransaction(async (client) => {
      const before = (
        await client.query<{ current_stage_id: string; stage_changed_at: Date }>(
          `select current_stage_id, stage_changed_at from persons where id = $1`,
          [probeTarget.id],
        )
      ).rows[0];

      await client.query(
        `insert into decision_events
           (church_id, person_id, event_type, occurred_at, stage_id_at_event, source, notes, recorded_by_staff_id)
         values ($1, $2, 'salvation', now(), $3, 'staff_entry', 'verify probe: first decision', $4)`,
        [counts.church_id, probeTarget.id, before.current_stage_id, owner.id],
      );

      const afterFirst = (
        await client.query<{ current_stage_id: string; stage_changed_at: Date }>(
          `select current_stage_id, stage_changed_at from persons where id = $1`,
          [probeTarget.id],
        )
      ).rows[0];
      check(
        "recording a decision does NOT move the person's stage",
        afterFirst.current_stage_id === before.current_stage_id,
      );
      check(
        "recording a decision does NOT restart the dwell clock",
        new Date(afterFirst.stage_changed_at).getTime() === new Date(before.stage_changed_at).getTime(),
      );

      // Decisions are repeatable facts, not a one-per-person slot — a second,
      // different kind for the same person must also succeed.
      await client.query(
        `insert into decision_events
           (church_id, person_id, event_type, occurred_at, stage_id_at_event, source, notes, recorded_by_staff_id)
         values ($1, $2, 'rededication', now(), $3, 'staff_entry', 'verify probe: second decision', $4)`,
        [counts.church_id, probeTarget.id, before.current_stage_id, owner.id],
      );
      const decisionCount = Number(
        (
          await client.query<{ count: string }>(
            `select count(*)::text as count from decision_events where person_id = $1 and notes like 'verify probe:%'`,
            [probeTarget.id],
          )
        ).rows[0].count,
      );
      check(
        "a second decision for the same person is recorded, not rejected",
        decisionCount === 2,
        `${String(decisionCount)} probe decisions`,
      );

      const afterSecond = (
        await client.query<{ current_stage_id: string; stage_changed_at: Date }>(
          `select current_stage_id, stage_changed_at from persons where id = $1`,
          [probeTarget.id],
        )
      ).rows[0];
      check(
        "a second decision still does NOT move the stage or clock",
        afterSecond.current_stage_id === before.current_stage_id &&
          new Date(afterSecond.stage_changed_at).getTime() === new Date(before.stage_changed_at).getTime(),
      );

      throw new Rollback("verify: roll back decision-event probes");
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  const decisionCountAfterRollback = Number(
    (
      await query<{ count: string }>(
        `select count(*)::text as count from decision_events where person_id = $1 and notes like 'verify probe:%'`,
        [probeTarget.id],
      )
    )[0].count,
  );
  check("decision-event probes were rolled back", decisionCountAfterRollback === 0);

  console.log("\nThe read-only person record");
  const record = await fetchPersonRecord(withQuery, counts.church_id, probeTarget.id);
  check("the record returns the person", record !== null && record.person.id === probeTarget.id);
  check(
    "with their household and contact details",
    record !== null && "householdName" in record.person && "email" in record.person,
  );
  check(
    "with the stage clock they are sitting on",
    record !== null && typeof record.person.daysInStage === "number" && record.person.daysOverdue === probeTarget.daysOverdue,
  );
  check(
    "with numbered visits that distinguish the first from a return",
    record !== null && record.visits.length >= 1 && record.visits[0].visitNumber === 1,
    `${String(record?.visits.length ?? 0)} visits`,
  );
  check(
    "with the stage history that produced their timeline",
    record !== null && record.stageHistory.length >= 1 && record.stageHistory.every((h) => h.toStageName !== null),
  );
  check(
    "with their contact log, and nothing invented when it is empty",
    record !== null && Array.isArray(record.interactions),
    `${String(record?.interactions.length ?? 0)} interactions`,
  );
  check(
    "a person id that is not in this church reads as not found",
    (await fetchPersonRecord(withQuery, counts.church_id, "00000000-0000-0000-0000-000000000000")) === null,
  );
  check(
    "no base table stores 'overdue' — it is derived when the page loads",
    Number(
      (await query<{ count: string }>(
        `select count(*)::text as count from information_schema.columns c
          join information_schema.tables t
            on t.table_schema = c.table_schema and t.table_name = c.table_name
         where c.table_schema = 'public' and c.column_name ilike '%overdue%'
           and t.table_type = 'BASE TABLE'`,
      ))[0].count,
    ) === 0,
  );

  console.log(
    `\n${failures === 0 ? "All checks passed." : `${String(failures)} check(s) FAILED.`} (pre-flight hash smoke: ${hashPassword("x").startsWith("scrypt$") ? "scrypt ok" : "scrypt broken"})`,
  );
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error("\nVerification failed to run:");
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
