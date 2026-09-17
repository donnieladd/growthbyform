# Automation service

The foundation for Engine 5 (automation/trigger runtime) and Engine 9
(integrations) from `docs/HANDOFF.md` / the architecture doc — neither
existed before this. It is a separate Go process, not a rewrite of anything
in the TS app: the TS app (`../src`) is untouched, and this service never
imports from it or calls it. The only thing the two share is the one
Postgres database.

## Why a second service, and why Go

Full reasoning lives in conversation history with the owner, short version:
the TS app is a request/response admin console — low concurrency, and its
correctness already lives in Postgres (triggers, the `person_stage_clock`
view). The automation runtime is the opposite shape: an always-on background
process fanning out to SMS/email, processing webhooks, running scheduled
sweeps — exactly what Go's concurrency model and single-binary ops story are
good at. Splitting here costs nothing today because Engine 5/9 didn't exist
yet — there was nothing to rewrite.

## How it's wired to the TS app

One new table, `automation_events` (`../db/migrations/0004_automation_events.sql`),
is the entire coupling surface:

- DB triggers (owned by that migration, not by this service) write a row
  there whenever something automation-relevant happens — today: a stage
  change (extends `record_stage_change()`, same pattern the TS app's own
  migration 0003 already used to fix 0002 without editing it) and a
  connect-card submission (first-time vs. returning).
- This service is the **only** reader of that table. The TS app writes and
  forgets; it never reads its own writes back.
- A `pg_notify('automation_events', ...)` fires on insert for low-latency
  wake-up, but the table itself — not the notification — is the durable
  source of truth. Postgres NOTIFY is fire-and-forget: if this service is
  down when an event fires, there's no notification once it comes back, but
  the row is still sitting there. The poll loop (`OUTBOX_POLL_INTERVAL`) is
  what actually guarantees delivery.

## What's in this first slice

- `internal/db` — one shared `pgxpool.Pool`.
- `internal/outbox` — `Listener`: LISTEN + poll, `for update skip locked`
  claiming (so two instances of this process never double-process a row),
  stale-claim recovery (a claim older than `StaleClaimAfter` is treated as
  abandoned and re-claimed), dispatch, mark-processed-or-retry.
- `internal/scheduler` — the time-based half of Engine 5. Currently one job:
  a stall sweep that turns "who is overdue" (already fully derived by
  `person_stage_clock`, nothing new computed here) into exactly one
  `stall_detected` outbox event per stage-entry, so a person who stays
  overdue doesn't get re-flagged every sweep.
- `internal/dispatch` — the action layer. **`LogDispatcher` is a stub — it
  logs what it would have done and does not send anything.**

## The real blocker

Wiring an actual SMS/email send needs a provider account (Twilio or
equivalent for SMS, Resend/SendGrid for email) and its credentials. Nobody
has picked one yet, and this service does not fabricate that decision or a
fake integration. Until a provider is chosen, `LogDispatcher` lets the entire
pipeline — trigger → outbox → claim → dispatch → mark-processed — run and be
verified end to end with nothing pretending to be a sent message. Swapping
in a real dispatcher later is a new type implementing `outbox.Dispatcher`;
nothing else in this package changes.

## Running it

```bash
DATABASE_URL="postgres://user:pass@host:5432/db" go run ./cmd/automation
```

Environment variables (all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — | Required. Same Postgres instance the TS app uses. |
| `OUTBOX_POLL_INTERVAL` | `5` (seconds) | Durable-fallback poll cadence. Accepts a bare integer (seconds) or a Go duration string (`30s`, `1m`). |
| `STALL_SWEEP_INTERVAL` | `1h` | How often the scheduler checks for newly-overdue people. |

Build a binary with `go build -o bin/automation ./cmd/automation`.

## Verifying this slice

Migrations apply through the same runner the TS app uses
(`bun run db:migrate` from the repo root) — `0004_automation_events.sql` is
additive only. This slice was verified against a real ephemeral Postgres
(migrate → seed → run this service): the scheduler's stall sweep raised
exactly the 5 overdue people the seed itself reports, a second run raised
zero duplicates, and every event ended up `processed_at is not null` with
none stuck claimed. `bun run db:verify` was re-run afterward with no
regressions.
