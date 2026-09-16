# Task 02 — MVP slice 3: decision events in the UI

**Backlog id:** `e32ce51d-4fa1-41db-a0fc-8736a85abaaa`
**Status:** Not started. The data layer exists; the UI to record does not.

## Goal

A person's timeline shows decision events (salvation, rededication, baptism) recorded as repeatable,
timestamped facts — and staff can record one from the person's page in a few taps.

## What already exists

- **Table** `decision_events` (migration `0001_spine.sql`): repeatable, timestamped facts,
  structurally separate from stage and step completion. Recording one never moves anybody — that's a
  design invariant, keep it.
- **Seed data:** 4 decision events exist in the production DB.
- **Person record page** `/staff/people/$id` (`src/routes/staff.people.$id.tsx`,
  `src/server/person.ts`): read-only today, and it already *displays* decisions.
- Pipeline cards show a decision marker (read from the same data).

## What to build

1. A "Log decision" control on the person record page: pick kind (salvation / rededication / baptism
   — from data or config, not hard-coded if avoidable), date, optional note.
2. Server function (`src/server/person.ts` or a new `src/server/decisions.ts`) writing through the
   same tenant-safe path as everything else (`church_id` scoping, same-church triggers).
3. Timeline renders the new event immediately; a second event of the same kind can be added
   (repeatable facts).
4. Ensure recording a decision does NOT change stage, stage history, or the dwell clock.

## Constraints

Follow `/home/team/shared/WORKFLOW.md` and `ENGINEER-NOTES.md`. No `.env`, no git in the tree, no
server restarts. All DB access in server functions (`createServerFn`), never client code.

## Definition of done

`bun run build` green; real-browser verification: log a decision for a test person, see it on the
timeline, log a second one, confirm stage and clock untouched (check `stage_changed_at` via psql).
Automated checks in `scripts/verify.ts` extended if practical.
