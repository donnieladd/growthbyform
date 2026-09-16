// Server functions for the pipeline board, the coach task list, and the two
// mutations those screens perform (move a person, log a contact).
//
// Same discipline as ./people.ts: this module is imported by routes, so apart from
// createServerFn it imports NOTHING server-only at module scope. Cookies, sessions
// and Postgres are pulled in inside each handler body, and the SQL itself lives in
// ./queries.ts where scripts/verify.ts runs the very same statements.
//
// Two product rules are visible in the shape of this file:
//   * moving somebody is an explicit, separate action (movePersonStage), and
//   * logging a contact (logPersonInteraction) writes a person_interactions row and
//     touches nothing else — it cannot move a stage, because it never calls
//     set_person_stage() and never writes persons.current_stage_id.

import { createServerFn } from "@tanstack/react-start";
import { SESSION_COOKIE } from "../lib/session-constants";
import { fetchCoachTasks, fetchPipeline } from "./queries";

// ---------------------------------------------------------------------------
// Types shared with the routes (and with ./queries.ts, type-only)
// ---------------------------------------------------------------------------

export type PipelineCard = {
  id: string;
  fullName: string;
  householdName: string | null;
  stageId: string;
  stageName: string;
  stageSequence: number;
  daysInStage: number;
  expectedDwellDays: number | null;
  daysOverdue: number | null;
  isOverdue: boolean;
  visitCount: number;
  firstVisitOn: string | null;
  lastVisitOn: string | null;
  lastContactOn: string | null;
  visitStatus: "first-time" | "returning" | "no-visits";
  isSecondVisit: boolean;
  decisionCount: number;
  hasDecision: boolean;
  reviewFlag: string | null;
  assignedCoachName: string | null;
};

export type PipelineColumn = {
  id: string;
  name: string;
  sequence: number;
  expectedDwellDays: number | null;
  checkpointKind: string | null;
  isTerminal: boolean;
  cards: PipelineCard[];
};

export type PipelineResult =
  | {
      state: "ok";
      churchName: string;
      configName: string;
      columns: PipelineColumn[];
      overdueCount: number;
      totalPeople: number;
    }
  | { state: "unauthenticated" }
  | { state: "setup-required"; message: string };

export type CoachTaskRow = {
  id: string;
  fullName: string;
  stageName: string;
  stageSequence: number;
  daysInStage: number;
  expectedDwellDays: number;
  daysOverdue: number;
  lastContactOn: string | null;
  lastVisitOn: string | null;
  visitCount: number;
  assignedCoachName: string | null;
  assignedCoachUserId: string | null;
  reviewFlag: string | null;
};

export type CoachTaskResult =
  | {
      state: "ok";
      churchName: string;
      staffName: string;
      staffUserId: string;
      scope: TaskScope;
      tasks: CoachTaskRow[];
      overdueAll: number;
      overdueMine: number;
      overdueUnassigned: number;
      myPeople: number;
    }
  | { state: "unauthenticated" }
  | { state: "setup-required"; message: string };

export type TaskScope = "mine" | "all";

export type MoveStageResult =
  | {
      state: "ok";
      moved: boolean;
      personName: string;
      fromStageName: string | null;
      toStageName: string;
      message: string;
    }
  | { state: "unauthenticated" }
  | { state: "setup-required"; message: string }
  | { state: "error"; message: string };

export type LogContactResult =
  | { state: "ok"; personName: string; kind: string; message: string }
  | { state: "unauthenticated" }
  | { state: "setup-required"; message: string }
  | { state: "error"; message: string };

export const CONTACT_KINDS = ["call", "text", "email", "in_person", "note"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const getPipelineBoard = createServerFn({ method: "GET" }).handler(
  async (): Promise<PipelineResult> => {
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

    return await fetchPipeline(query, auth.session.churchId, auth.session.churchName);
  },
);

export const getCoachTasks = createServerFn({ method: "GET" })
  .validator((input: { scope?: unknown }) => ({
    scope: (input?.scope === "mine" ? "mine" : "all") as TaskScope,
  }))
  .handler(async ({ data }): Promise<CoachTaskResult> => {
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

    return await fetchCoachTasks(query, auth.session, data.scope);
  });

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Move a person to another stage. This is the only write on the board, it is
 * explicit, and it goes through set_person_stage(), which writes the stage_history
 * row (from → to, who, when) and stamps persons.stage_changed_at — the moment the
 * dwell clock for the new stage starts counting from.
 */
export const movePersonStage = createServerFn({ method: "POST" })
  .validator((input: { personId?: unknown; toStageId?: unknown; reason?: unknown; expectedFromStageId?: unknown }) => ({
    personId: typeof input?.personId === "string" ? input.personId : "",
    toStageId: typeof input?.toStageId === "string" ? input.toStageId : "",
    reason: typeof input?.reason === "string" ? input.reason.slice(0, 400) : "",
    // The stage the caller's board showed this person in when they clicked
    // move. Optional so nothing else calling this breaks; when present, a
    // mismatch means someone else moved this person since the board loaded.
    expectedFromStageId: typeof input?.expectedFromStageId === "string" ? input.expectedFromStageId : null,
  }))
  .handler(async ({ data }): Promise<MoveStageResult> => {
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
    if (!data.personId || !data.toStageId) {
      return { state: "error", message: "Pick a person and a stage." };
    }

    const churchId = auth.session.churchId;
    try {
      return await withTransaction(async (client) => {
        const person = (
          await client.query<{ id: string; full_name: string; current_stage_id: string | null }>(
            `select id, full_name, current_stage_id from persons
              where id = $1 and church_id = $2
              for update`,
            [data.personId, churchId],
          )
        ).rows[0];
        if (!person) {
          return { state: "error", message: "That person is not on this church's list." };
        }

        let fromStageName: string | null = null;
        if (person.current_stage_id) {
          const from = (
            await client.query<{ name: string }>(
              `select name from growth_track_stages where id = $1`,
              [person.current_stage_id],
            )
          ).rows[0];
          fromStageName = from?.name ?? null;
        }

        if (data.expectedFromStageId && data.expectedFromStageId !== person.current_stage_id) {
          return {
            state: "error",
            message: `${person.full_name} was already moved${fromStageName ? ` to ${fromStageName}` : ""} by someone else — refresh the board and try again.`,
          };
        }

        const stage = (
          await client.query<{ id: string; name: string }>(
            `select id, name from growth_track_stages where id = $1 and church_id = $2`,
            [data.toStageId, churchId],
          )
        ).rows[0];
        if (!stage) {
          return { state: "error", message: "That stage is not part of this church's track." };
        }

        if (person.current_stage_id === stage.id) {
          return {
            state: "ok",
            moved: false,
            personName: person.full_name,
            fromStageName,
            toStageName: stage.name,
            message: `${person.full_name} is already in ${stage.name} — nothing changed.`,
          };
        }

        await client.query(`select set_person_stage($1, $2, $3, $4, 'staff_entry')`, [
          person.id,
          stage.id,
          auth.session.staffUserId,
          data.reason.trim() || "Moved on the pipeline board",
        ]);

        return {
          state: "ok",
          moved: true,
          personName: person.full_name,
          fromStageName,
          toStageName: stage.name,
          message: `Moved ${person.full_name}${fromStageName ? ` from ${fromStageName}` : ""} to ${stage.name}. The new stage's dwell clock started now.`,
        };
      });
    } catch (err) {
      // Log the real error server-side; never hand raw DB error text (constraint
      // and column names) to the client.
      console.error("movePersonStage failed", err);
      return { state: "error", message: "That move did not save." };
    }
  });

/**
 * Log a contact. It writes one person_interactions row and NOTHING else: the
 * person's stage, their stage entry time and therefore their overdue status are
 * untouched. Reach out and re-rank somebody are two different decisions, and a
 * coach must not be able to confuse them.
 */
export const logPersonInteraction = createServerFn({ method: "POST" })
  .validator((input: { personId?: unknown; kind?: unknown; body?: unknown }) => ({
    personId: typeof input?.personId === "string" ? input.personId : "",
    kind: typeof input?.kind === "string" ? input.kind : "",
    body: typeof input?.body === "string" ? input.body.slice(0, 2000) : "",
  }))
  .handler(async ({ data }): Promise<LogContactResult> => {
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

    const kind = CONTACT_KINDS.find((k) => k === data.kind);
    if (!kind) {
      return { state: "error", message: "Pick how you reached out." };
    }
    const body = data.body.trim();
    if (!data.personId) {
      return { state: "error", message: "That contact is not attached to a person." };
    }
    if (kind === "note" && body.length === 0) {
      return { state: "error", message: "A note needs something written in it." };
    }

    try {
      const person = (
        await query<{ id: string; full_name: string }>(
          `select id, full_name from persons where id = $1 and church_id = $2`,
          [data.personId, auth.session.churchId],
        )
      )[0];
      if (!person) {
        return { state: "error", message: "That person is not on this church's list." };
      }

      await query(
        `insert into person_interactions (church_id, person_id, staff_user_id, kind, occurred_at, body)
         values ($1, $2, $3, $4, now(), $5)`,
        [auth.session.churchId, person.id, auth.session.staffUserId, kind, body || null],
      );

      return {
        state: "ok",
        personName: person.full_name,
        kind,
        message: `Logged against ${person.full_name}. Stage and overdue status unchanged.`,
      };
    } catch (err) {
      console.error("logPersonInteraction failed", err);
      return { state: "error", message: "That contact did not save." };
    }
  });
