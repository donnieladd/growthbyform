# Task 01 — Finish end-to-end verification against the production DB

**Backlog id:** `5a6304fa-f0a2-400e-b369-4ac5ba04f0cb`
**Status:** In progress at handoff. Capture (the hardest part) already verified.

## Goal

Prove the whole MVP flow by clicking it in a real browser against the working site
(`http://localhost:3000`) with `DATABASE_URL` injected — this is the gate before publishing (task 03).

## Already verified (do not redo)

- Automated: `db:migrate` → `db:seed --reset` → `db:verify` all exit 0 (~50 checks, including
  rolled-back move/contact probes), `bun run build` green (client + SSR).
- Browser, against production DB (2026-09-16):
  - Test guest "TEST-Veronica Ashby" submitted on `/connect` → person created at **First-Time
    Guest**, visit #1 recorded (`no_match_created`).
  - Near-duplicate submission (different email, same phone) → **matched on `phone_e164`** to the same
    person, visit #2 recorded as returning, `visit_count = 2`, no duplicate row.

## Remaining to click

1. **Staff auth:** sign in at `/login` with `pastor@demo.church / growthtrack-demo`; confirm the
   dashboard shows real data (overdue callout, per-stage counts).
2. **Pipeline board** `/staff/pipeline`: seven columns from the DB; move the TEST guest forward one
   stage via the card's "Move to stage" select + Move button; confirm the card moves, and via
   `psql "$DATABASE_URL"` that a `stage_history` row was written (from/to/who/when) and
   `persons.stage_changed_at` reset (dwell clock restarted, `days_in_stage = 0`). Move them back.
3. **Coach task list** `/staff/tasks`: 5 seeded overdue people shown most-overdue-first
   (Jonah Kim +24, Nia Johnson +16, Sam Whitfield +7, Marcus Webb +6, Tom Becker +5); the fresh TEST
   guest must NOT appear; `?scope=mine` is a strict subset; log a contact from a row and confirm the
   person drops nothing except last-contact updating (logging contact moves nobody — a one-line
   notice on the page says so).
4. **Person record** `/staff/people/<id>`: household/contact details, stage clock, numbered visits,
   stage history, contact log, decisions; a fake id renders "not found", not an error.

## Definition of done

Every step above clicked and observed; any bug found fixed and re-verified; `bun run build` green at
the end; tree left servable. Report states what was verified with observations, what was not, and
what remains.
