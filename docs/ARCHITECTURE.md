# Architecture

## Stack and shape

TanStack Start (React 19, Vite 7, Tailwind 4) served on port 3000. TypeScript throughout. Postgres
accessed with plain parameterised SQL — no ORM, no query builder. Bun runs scripts and the server.
All database access lives in server functions (`createServerFn` from TanStack Start); client code
never touches the database. Migrations are plain SQL files applied in order by the project's own
runner (`scripts/migrate.ts`), tracked in `schema_migrations`.

## Data model

Migrations: `db/migrations/0001_spine.sql`, `0002_rules_and_triggers.sql`,
`0003_stall_and_contact.sql`. 14 tables + 1 view.

### Core spine (0001)

| Table | Purpose |
| --- | --- |
| `churches` | The tenant root. One row per church. |
| `households` | Family unit; a person belongs to a household. |
| `persons` | The one Person record everything reads from: household, contact details, `current_stage_id`, `stage_changed_at` (when the dwell clock started), `visit_count`, email/phone normalised columns, `assigned_coach_user_id`, `last_contact_at`, `review_flag`. |
| `growth_track_configs` | A church's growth track configuration. |
| `growth_track_stages` | The stages of a track, in order, with `expected_dwell_days` (NULL = terminal stage, no expectation). |
| `stage_history` | Append-only audit of every stage move: from, to, who, when, why, source. |
| `step_completions` | Completion of individual track steps by a person. |
| `decision_events` | Salvation / rededication / baptism as **repeatable, timestamped facts** in their own table — structurally separate from stage and step completion. Recording one never moves anybody. |
| `connect_card_submissions` | Every public card submission, with `visit_report` (first_time / returning) and `matched_on` (which identity signal resolved it). |
| `person_visits` | Numbered visits per person with `visit_report` and `attended_at`. |

### Contact and coaching (0003)

| Table / column | Purpose |
| --- | --- |
| `person_interactions` | The contact log: kind (`call`/`text`/`email`/`in_person`/`note`), `occurred_at`, `body`, optional `staff_user_id` (NULL = system). Indexed by person (newest first), by church, by (church, staff). |
| `persons.assigned_coach_user_id` | Nullable, church-scoped FK to `staff_users`. What "My people" filters on. |
| `persons.last_contact_at` | **Derived rollup, never hand-set** — a trigger recomputes it as the greatest of the person's logged contact, last visit, last decision, and last connect-card submission. Keeps the board honest without aggregating four tables per card. |
| `person_stage_clock` (view) | The single definition of stall detection: `days_in_stage = now()::date - persons.stage_changed_at::date`, `days_overdue = days_in_stage - expected_dwell_days`. **Overdue is never stored** — no cron, no scheduler, no background process. The board, the task list, the dashboard count, and the verify suite all read this one view, so they cannot disagree. |

### Staff and auth (0001)

`staff_users` (email/password per church, role owner/coach) and `staff_sessions` (server-side
session cookies). Auth in `src/lib/auth.ts` + `src/server/auth-core.ts`; guards in the `staff` route
layout. Signed-out staff routes 307 to `/login`.

## Design invariants (enforced in the database, not just the app)

1. **`set_person_stage()` is the only blessed way to move somebody.** It writes the `stage_history`
   row (from, to, who, when) and stamps `persons.stage_changed_at` — the moment the dwell clock runs
   from. App code calls it; nothing else mutates stage columns.
2. **Tenant isolation.** `enforce_same_church()` triggers stop cross-tenant rows: a person, stage, or
   staff user referenced from another church is rejected at write time. Every tenant-scoped table
   carries `church_id`. Per-church isolation is a config change, not a rewrite.
3. **`validate_growth_track_config()` refuses a broken track:** missing a required checkpoint,
   Belonging not first, or Deployment sequenced before Self-understanding. Community/small groups is
   a *parallel destination*, never a sequenced step or checkpoint.
4. **Decisions are facts, not transitions.** `decision_events` never changes stage, stage history, or
   the dwell clock.
5. **Overdue is derived, never stored** (see the view above). There is no scheduler anywhere in the
   system to forget to run.

## Identity resolution (capture)

`src/server/identity.ts` resolves a connect-card submission to an existing person via
phone (E.164-normalised) / email (lower-cased) / household / name matching, in priority order. A
first-time submission creates the person, household, and first visit (`matched_on =
'no_match_created'`); a returning submission attaches visit #2+ to the same person
(`matched_on = 'phone_e164'` etc.) and records the second visit as a distinct, more-urgent event.
Verified in a real browser: same phone + different email resolves to the same person, no duplicate.

## Known fixed bug (worth knowing)

Migration 0002's `record_stage_change()` used `current_setting(...) not in ('', null)` to decide
whether to honour the caller's actor and timestamp — an expression that is NULL, not TRUE, for any
real value. Every stage move was therefore recorded with a NULL actor and `changed_at = now()`, and
`persons.stage_changed_at` was always "now" — which would have made stall detection worthless (nobody
is ever overdue if every clock restarts at write time). Migration 0003 installs a corrected
`record_stage_change()` (`nullif(...)` + `is not null`); 0002 is left untouched as the runner
requires. Anything built on `stage_history.changed_at` or `persons.stage_changed_at` **before** 0003
was applied should be treated as having today's timestamp.

## Deliberately out of scope (for now)

Small groups platform, message amplification, member app/portal, Planning Center / Monday.com sync,
our own SMS/email sending, the full automation runtime, billing, editing a person, merging flagged
duplicates, reassigning coaches via UI, recording decision events in the UI (the table, seed data,
and read-only display exist — the recording UI is slice 3).
