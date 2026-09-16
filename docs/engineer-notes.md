# Growth Track by Form — engineer notes

Updated for **Slice 2** (pipeline board, stall detection, coach task list, person
record). Slice 1's section is kept below, because its schema and commands are still
exactly what this slice builds on.

## Slice 2 — what changed

| Piece | Where |
| --- | --- |
| Contact log + stall detection (new migration) | `db/migrations/0003_stall_and_contact.sql` |
| Board + task list SQL, person-record SQL | `src/server/queries.ts` (`PIPELINE_CARDS_SQL`, `COACH_TASKS_SQL`, `OVERDUE_SUMMARY_SQL`, `PERSON_*_SQL`) |
| Board, task list, move + log-contact server functions | `src/server/pipeline.ts` |
| Person record server function | `src/server/person.ts` |
| Board screen | `src/routes/staff.pipeline.tsx` → `/staff/pipeline` |
| Coach task list | `src/routes/staff.tasks.tsx` → `/staff/tasks` (`?scope=mine` / `all`) |
| Read-only person record | `src/routes/staff.people.$id.tsx` → `/staff/people/$id` |
| Dashboard overdue callout + per-stage counts | `src/routes/staff.index.tsx` |
| Seed: coaches, coach assignment, aged stage entries, contact log | `scripts/seed.ts` |
| Slice 2 verification (50+ checks, incl. rolled-back move/contact probes) | `scripts/verify.ts` |

### New tables and columns

- **`person_interactions`** — the contact log: `church_id`, `person_id`,
  `staff_user_id` (nullable = system), `kind` (`call`, `text`, `email`, `in_person`,
  `note`), `occurred_at`, `body`, `created_at`. Indexed by person (newest first), by
  church, and by (church, staff). Same-church triggers enforce tenant consistency.
- **`persons.assigned_coach_user_id`** — nullable, church-scoped FK to `staff_users`;
  this is what "my people" filters on. Indexed `(church_id, assigned_coach_user_id)`
  where not null, with a same-church trigger.
- **`persons.last_contact_at`** — derived rollup, not a hand-set column. A trigger on
  `person_interactions`, `person_visits`, `decision_events` and
  `connect_card_submissions` recomputes it as the greatest of the person's logged
  contact, last visit, last decision and last connect-card submission. That keeps the
  board honest for 2,000 people without aggregating four tables per card.
- **`person_stage_clock` (view)** — the single definition of stall detection:
  `days_in_stage = now()::date - persons.stage_changed_at::date` and
  `days_overdue = days_in_stage - expected_dwell_days` (NULL where the stage sets no
  expectation, e.g. the terminal stage). **Overdue is never stored** — no cron, no
  scheduler, no background process. The board, the task list, the dashboard count and
  `db:verify` all read this one view, so they cannot disagree.

### Bug fixed in this slice (important)

`record_stage_change()` from migration **0002** decided whether to use the caller's
actor and time with `current_setting(...) not in ('', null)`. That expression is
**NULL, not TRUE**, for any real value (`x IN ('', NULL)` → `false OR NULL` → NULL),
so the branch never ran: every stage move was recorded with a NULL actor and
`changed_at = now()`, and `persons.stage_changed_at` was always "now" — which would
have made stall detection useless (nobody is ever overdue if every clock restarts at
the moment of the write). Migration 0003 installs a corrected `record_stage_change()`
(same name, same contract) using `nullif(...)` + `is not null`. 0002 was left
untouched, as the runner requires.

### Seed behaviour for this slice

- A second staff account, **`coach@demo.church` / `growthtrack-demo`** (role `coach`,
  name Ruth Osei), so "my people" has something real to filter on. Dana Reyes
  (`pastor@demo.church`, the sign-in most people will use) owns 5 people, Ruth owns 5,
  one is unassigned.
- Stage entry times are set with a new `exactDaysAgo()` helper (no Sunday snapping), so
  "days in stage" is exactly the number intended. The demo therefore shows a real task
  list on first load: **5 people overdue across 4 different stages** — Jonah Kim
  (+24, Complete), Nia Johnson (+16, Enrolled), Sam Whitfield (+7, Returning Guest),
  Marcus Webb (+6, Enrolled), Tom Becker (+5, First-Time Guest) — plus six people
  comfortably inside their dwell so the board does not look uniformly overdue.
- 13 seeded contact-log entries, so "last contact" is meaningful on the board.

## Slice 1 — spine + capture (unchanged)

Storage schema in `db/migrations/0001_spine.sql` + `0002_rules_and_triggers.sql`;
migration runner `scripts/migrate.ts`; seed `scripts/seed.ts`; data-path check
`scripts/verify.ts`; Postgres access `src/lib/pg.ts`; in-house auth
(`src/lib/auth.ts`, `src/server/auth-core.ts`); identity resolution
(`src/server/identity.ts`); staff shell and guards in `src/routes/**`.

Rules enforced in the database: `validate_growth_track_config()` refuses a track
missing a required checkpoint, with belonging not first, or with deployment before
self-understanding; `enforce_same_church()` stops cross-tenant rows;
`set_person_stage()` is the one blessed way to move somebody (it writes
`stage_history` and stamps `stage_changed_at`, the moment the dwell clock runs from).

Community/small groups is a **parallel destination**, never a sequenced step or
checkpoint. Decision events are **repeatable, timestamped facts** in their own table,
structurally separate from stage and step completion — recording one never moves
anybody.

## Running it

```bash
cd /home/team/shared/site
bun install
bun run db:migrate      # 0001, 0002, 0003
bun run db:seed         # church + 2 staff + 7 stages + 11 demo people; `-- --reset` rebuilds
bun run db:verify       # 50+ checks; the move/contact probes roll themselves back
bun run db:status       # applied / pending migrations only
bun run build           # must pass: client bundle + SSR
```

Environment: `DATABASE_URL` (standard Postgres URL, read from `process.env` only —
never a `.env` file). `DB_DRIVER=neon-http` switches back to the original Neon HTTP
helper in `src/db.ts`. `PUBLIC_CHURCH_SLUG` only matters with more than one church.
`SEED_STAFF_PASSWORD` overrides the demo password.

With **no** `DATABASE_URL`, the site still builds and serves and shows the honest
setup state (`/setup`, and `/staff` redirects to `/setup`): no crash, no invented
data. That degradation was re-checked in this slice.

### Demo credentials (demo tenant only)

```
pastor@demo.church / growthtrack-demo     (Dana Reyes, owner)
coach@demo.church  / growthtrack-demo     (Ruth Osei, coach)
```

## What was verified, and how

Against the local PostgreSQL 16 (`db:migrate` → `db:seed --reset` → `db:verify`, all
exit 0, and `bun run build` passes):

- all three migrations apply cleanly **from an empty database** (15 tables);
- the seed prints the overdue list derived from the view — 5 people, 4 stages, each
  with the coach who owns them;
- **the board**: columns are the church's own stages in order from
  `growth_track_stages`, one card per person, every card carries visit facts (first vs
  returning) and a stage clock, and every card past its stage's dwell is marked
  overdue while no other card is;
- **stall detection**: the task list equals the overdue set, every row genuinely past
  its dwell (`daysOverdue === daysInStage - expected`), sorted most-overdue first, and
  no base table stores "overdue" anywhere;
- **"my people"** filters on `assigned_coach_user_id` and is a strict subset (3 of 5
  for Dana Reyes);
- **logging a contact** (rolled back): writes the interaction, updates derived
  `last_contact_at`, and leaves the stage **and** `stage_changed_at` untouched — the
  task list still shows the same overdue count;
- **moving somebody** (rolled back): lands them in the new stage, restarts the dwell
  clock (`days_in_stage = 0`), drops them off the task list, and writes exactly one
  `stage_history` row recording from, to, who and when;
- **the person record**: household and contact details, the stage clock, numbered
  visits with first/returning distinguished, stage history, contact log, decisions,
  and a fake id reading as "not found" rather than erroring;
- identity resolution still refuses to duplicate a returning guest (slice 1 checks all
  still pass), and the checkpoint-rule self-test still refuses a broken track.

## Not done / not verified

- **The page-level click-through was not completed in this session.** The working site
  on port 3000 has no `DATABASE_URL`, so proving it in a browser needs a second dev
  server pointed at the local database; the terminal in this session became unreliable
  (commands executed but output stopped coming back), so the screenshots could not be
  captured. Everything the screens read and write was verified against real Postgres
  through the same SQL and server-function code paths (`db:verify`), and the build is
  green — but nobody has yet clicked the board with a live database behind it.
  **Next step:** with `DATABASE_URL` on the site, open `/staff/pipeline`, move a card,
  open `/staff/tasks`, log a contact, and open `/staff/people/<id>`.
- **Drag-and-drop was not added.** The card's "Move to stage" select + Move button is
  the control; the brief said a reliable control beats fiddly drag. No new
  dependencies were added.
- Deliberately out of scope (later slices): recording decision events in the UI,
  editing a person, merging flagged duplicates, the track-config editor UI, small
  groups, message amplification, member portal, Planning Center / Monday.com sync,
  our own SMS/email sending, automation runtime, billing.
- `src/db.ts` (the original Neon HTTP helper) is still untouched.

## Flags for the lead

1. `DATABASE_URL` is still the one blocker between this and a clickable MVP — the
   working site shows setup state until the owner connects the database. Any standard
   Postgres URL works.
2. The seeded staff passwords are real passwords on a real login form (the demo
   tenant). Change or delete them before the church holds real people.
3. The slice-2 bug fix in migration 0003 corrects behaviour that migration 0002
   shipped: stage moves recorded no actor and no backdated time. Anything built on
   `stage_history.changed_at` or `persons.stage_changed_at` **before** 0003 was
   applied should be treated as having today's timestamp.
4. Two staff accounts now exist in the demo tenant; "my people" is only meaningful
   because people are assigned to them. Assignment is a data field today — a UI for
   reassigning coaches is not built yet.
