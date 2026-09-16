# Verification — what was tested, how, and what was not

The project's rule: **nobody says "tested" without an observation.** This file records what was
verified, with what was actually seen, and what was explicitly not.

## The test suite: `scripts/verify.ts`

`bun run db:verify` runs 50+ automated checks against `DATABASE_URL` and exits non-zero on the first
failure. It covers the whole data path — the same SQL and server-function code the UI uses:

- all migrations present and applied; the checkpoint-rule self-test refuses a broken track config
  (missing required checkpoint, Belonging not first, Deployment before Self-understanding);
- tenant isolation: cross-church references are rejected by the `enforce_same_church()` triggers;
- identity resolution refuses to duplicate a returning guest;
- **logging a contact** (in a rolled-back transaction): writes the interaction, updates the derived
  `last_contact_at`, and leaves stage **and** `stage_changed_at` untouched — the task list would
  still show the same overdue count;
- **moving somebody** (rolled back): lands the new stage, restarts the dwell clock
  (`days_in_stage = 0`), drops them off the task list, and writes exactly one `stage_history` row
  with from, to, who, when;
- **"My people"** is a strict subset filtered on `assigned_coach_user_id`;
- the person record's reads (household, contacts, visits, stage history, contact log, decisions) and
  a fake id reading as "not found" rather than erroring;
- stall detection: the task list equals the overdue set from the `person_stage_clock` view, sorted
  most-overdue-first, with no base table storing "overdue" anywhere.

The intrusive probes run inside transactions and roll back, so the suite is safe to run repeatedly
against real data. Historical note: an earlier variant wrote probe rows to the production database —
the rolled-back design replaced it.

## Real-browser verification (2026-09-16)

Run in real Chromium against a dev server on port 3100 serving this exact tree with `DATABASE_URL`
set — i.e. against the **production database**. (Port 3000's managed server lacked the variable in
its process environment at the time — see RUNBOOK.md.)

**What was clicked and seen:**

1. **Capture — new guest.** Full connect card submitted for a test person ("TEST-Veronica Ashby").
   Page showed "First visit recorded / New record created / Thank you, TEST-Veronica / You are on the
   track at: First-Time Guest". Database confirmed: new person row, `visit_count = 1`, stage
   First-Time Guest, household created, submission `visit_report='first_time'`,
   `matched_on='no_match_created'`.
2. **Capture — near-duplicate.** Same phone, different email, "I have been before". Page showed
   "Visit #2 recorded / Second visit — strongest signal / Matched an existing record". Database:
   **same person id**, `visit_count = 2`, new visit row `visit_report='returning'`,
   `matched_on='phone_e164'` — no duplicate record.
3. **Staff auth.** Signed in at `/login` as the demo owner → redirected to `/staff` showing the demo
   church, the signed-in user, 12 people, 5 overdue — real database data.
4. **Pipeline board + audit trail.** Seven stage columns populated from the database. Moved the test
   guest First-Time Guest → Returning Guest using the card's "Move to stage" control, then back.
   Database confirmed `persons.current_stage_id` and `stage_changed_at` updated, and exactly three
   `stage_history` rows: (system → First-Time Guest), (First-Time Guest → Returning Guest, by Dana
   Reyes, "Moved on the pipeline board", source `staff_entry`), (Returning Guest → First-Time Guest,
   same actor).
5. **Stall detection.** `/staff/tasks` showed "5 people are past their stage's expected dwell", with
   Everyone (5) / My people (3) and per-row dwell numbers identical to the `person_stage_clock` view
   (Jonah Kim 45/21 +24, Nia Johnson 44/28 +16, Sam Whitfield 21/14 +7, Marcus Webb 34/28 +6, Tom
   Becker 12/7 +5). The fresh test guest read "On pace" and was absent from the list.

Screenshots of the board and task list were captured during the earlier slice-2 session (same
queries; the seed's overdue set is deterministic).

**Explicitly NOT verified in a browser:**

- **Recording a decision event from the UI — the feature does not exist yet.** The person page is
  read-only; the four seeded decision events display correctly on the timeline (with the
  stage-at-the-time and the "a decision never moves anybody" note), and separateness is structural
  (`decision_events` is its own table), but recording one is slice 3. See HANDOFF.md.
- The connect-card flow on port 3000 specifically (blocked by the environment caveat above — run it
  as part of the publish checklist once the serving process can reach the database).

## Build verification

`bun run build` passes as of the last change (exit 0; client bundle + SSR both green). Migrations
were also verified to apply cleanly **from an empty database** (15 objects: 14 tables + 1 view).

## Test data cleanup

The browser verification left one deliberate test person in the production database for inspection:

```sql
-- person TEST-Veronica Ashby, household "The Ashbys Household", 2 visits,
-- 1 submission pair, 3 stage_history rows:
delete from persons where last_name='Ashby' and first_name like 'TEST%';  -- cascades
```

Or wipe and rebuild everything demo: `bun run db:seed -- --reset`.
