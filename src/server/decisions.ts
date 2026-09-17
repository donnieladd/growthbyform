// Recording a decision event (salvation, rededication, baptism). Slice 3 of
// docs/handoff/02-slice-3-decision-events.md.
//
// The one invariant that matters more than anything else in this file: this
// NEVER touches persons.current_stage_id or persons.stage_changed_at. A
// decision is a repeatable, timestamped fact (decision_events, 0001_spine.sql)
// — structurally separate from stage and step completion. If a future edit
// to this file ever writes to persons, it has broken that invariant.

import { createServerFn } from "@tanstack/react-start";
import { SESSION_COOKIE } from "../lib/session-constants";

export const DECISION_KINDS = ["salvation", "rededication", "baptism"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export type LogDecisionResult =
  | { state: "ok"; personName: string; kind: DecisionKind; message: string }
  | { state: "unauthenticated" }
  | { state: "setup-required"; message: string }
  | { state: "error"; message: string };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const logDecisionEvent = createServerFn({ method: "POST" })
  .validator((input: { personId?: unknown; kind?: unknown; occurredOn?: unknown; notes?: unknown }) => ({
    personId: typeof input?.personId === "string" ? input.personId : "",
    kind: typeof input?.kind === "string" ? input.kind : "",
    occurredOn: typeof input?.occurredOn === "string" ? input.occurredOn : "",
    notes: typeof input?.notes === "string" ? input.notes.slice(0, 2000) : "",
  }))
  .handler(async ({ data }): Promise<LogDecisionResult> => {
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

    const kind = DECISION_KINDS.find((k) => k === data.kind);
    if (!kind) {
      return { state: "error", message: "Pick what kind of decision this was." };
    }
    if (!data.personId) {
      return { state: "error", message: "That decision is not attached to a person." };
    }

    // A plain <input type="date"> sends "YYYY-MM-DD"; noon UTC avoids the
    // date rolling to the previous day in a timezone behind UTC.
    let occurredAt: Date;
    if (!data.occurredOn) {
      occurredAt = new Date();
    } else if (DATE_ONLY.test(data.occurredOn)) {
      occurredAt = new Date(`${data.occurredOn}T12:00:00.000Z`);
      if (Number.isNaN(occurredAt.getTime())) {
        return { state: "error", message: "That date does not look right." };
      }
    } else {
      return { state: "error", message: "That date does not look right." };
    }

    try {
      const person = (
        await query<{ id: string; full_name: string; current_stage_id: string | null }>(
          `select id, full_name, current_stage_id from persons where id = $1 and church_id = $2`,
          [data.personId, auth.session.churchId],
        )
      )[0];
      if (!person) {
        return { state: "error", message: "That person is not on this church's list." };
      }

      // stage_id_at_event is context only — 0001_spine.sql's own comment: "it
      // never moves them and the pipeline never treats it as state." Re-check
      // it belongs to this church rather than trust the column blindly: the
      // FK-level same-church trigger for this specific column ships in a
      // parallel PR and may not be applied on every deployment yet.
      let stageIdAtEvent: string | null = null;
      if (person.current_stage_id) {
        const stage = (
          await query<{ id: string }>(
            `select id from growth_track_stages where id = $1 and church_id = $2`,
            [person.current_stage_id, auth.session.churchId],
          )
        )[0];
        stageIdAtEvent = stage?.id ?? null;
      }

      // Deliberately: no write to persons anywhere in this function.
      await query(
        `insert into decision_events
           (church_id, person_id, event_type, occurred_at, stage_id_at_event, source, notes, recorded_by_staff_id)
         values ($1, $2, $3, $4, $5, 'staff_entry', $6, $7)`,
        [
          auth.session.churchId,
          person.id,
          kind,
          occurredAt,
          stageIdAtEvent,
          data.notes.trim() || null,
          auth.session.staffUserId,
        ],
      );

      return {
        state: "ok",
        personName: person.full_name,
        kind,
        message: `Recorded ${kind} for ${person.full_name}. Stage and dwell clock unchanged.`,
      };
    } catch (err) {
      console.error("logDecisionEvent failed", err);
      return { state: "error", message: "That decision did not save." };
    }
  });
