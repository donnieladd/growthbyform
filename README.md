# Growth Track by Form

A ministry operating system for the one pipeline a church can't afford to lose:
**first-time visitor → fully deployed, relationally-cared-for member.** One Person record and one
continuous stage timeline that every part of the church reads from and writes to. Other church tools
answer *what happened*; this answers *where is this person, and what does the church owe them next.*

**Status: MVP slices 1–2 built and verified end to end against a real Postgres database.**
Capture (connect card with identity resolution), the pipeline board, automatic stall detection, the
coach task list, contact logging, and the person record all work. See
[docs/VERIFICATION.md](docs/VERIFICATION.md) for exactly what was tested and how, and
[docs/HANDOFF.md](docs/HANDOFF.md) for what remains.

## What works today

- **The spine.** Postgres schema (14 tables) — Person, Household, GrowthTrackConfig,
  growth_track_stages, StageHistory, StepCompletion, DecisionEvent, connect-card submissions,
  person visits/interactions, staff users and sessions — with `church_id` on every tenant-scoped
  table and database-level tenant-isolation triggers.
- **Staff auth.** In-app email/password auth with server-side sessions; signed-out staff routes
  redirect to `/login`. Demo tenant seeded (credentials below).
- **Capture.** A public digital connect card at `/connect` that resolves submissions to the *same*
  person record through phone / email / household / name matching. First visit and second visit are
  distinct, differently-urgent events; a returning guest matched by phone never duplicates.
- **The pipeline board** `/staff/pipeline`. The seven default stages (First-Time Guest → Returning
  Guest → Growth Track Enrolled → Complete → Connected → Serving → Leading), columns read from the
  database (never hard-coded), per-card dwell clock, first/returning badge, last contact, coach, and
  an explicit "Move to stage" control. Every move writes an audit row (from, to, who, when, why).
- **Stall detection.** Each stage carries an expected dwell time; anyone past it surfaces on the
  coach task list `/staff/tasks` on its own. Overdue is **derived at read time** from one SQL view —
  no cron, no stored flag, nothing to rot.
- **Coach task list.** Most-overdue-first, "Everyone / My people" filter, per-row contact logging
  (call / text / email / in person / note). Logging a contact never moves anybody and never restarts
  the stage clock.
- **Person record** `/staff/people/$id`. Household and contact details, the stage clock, numbered
  visits (first vs returning), stage history, contact log, and decision events — read-only today.

## Quick start

```bash
bun install

# Point DATABASE_URL at any Postgres 14+ database (read from process.env — never a .env file):
export DATABASE_URL="postgresql://user:pass@host:5432/db"

bun run db:migrate      # applies db/migrations/0001, 0002, 0003 in order
bun run db:seed         # demo church + 2 staff + 7 stages + 11 demo people (use -- --reset to rebuild)
bun run db:verify       # 50+ automated data-path checks (the intrusive probes roll themselves back)
bun run build           # must pass: client bundle + SSR
bun run dev             # dev server
bun run start           # serve the production build
```

With **no** `DATABASE_URL`, the site still builds and serves and shows an honest setup state
(`/setup`; `/staff` redirects there). No crash, no invented data.

### Demo credentials (fictional demo tenant only)

```
pastor@demo.church / growthtrack-demo     (Dana Reyes, owner — 5 assigned people)
coach@demo.church  / growthtrack-demo     (Ruth Osei, coach — 5 assigned people)
```

> Rotate or delete these before any real church data goes in (`SEED_STAFF_PASSWORD` overrides the
> demo password at seed time).

The seed deliberately produces a live task list on first load: **5 people overdue across 4 stages**
(Jonah Kim +24, Nia Johnson +16, Sam Whitfield +7, Marcus Webb +6, Tom Becker +5) plus six people
comfortably inside their dwell.

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack, data model (every table), design invariants, identity resolution, stall detection, tenant isolation, auth |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Environment variables, migrate/seed/verify, building, serving, deployment, known environment caveats |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | The test suite (`scripts/verify.ts`, 50+ checks), what was verified in a real browser and what was seen, known gaps, test-data cleanup |
| [docs/HANDOFF.md](docs/HANDOFF.md) | Remaining work (slice 3 decision events, publish, track configuration, pricing research), housekeeping, decisions reserved for the owner |
| [docs/engineer-notes.md](docs/engineer-notes.md) | Build notes as they were written during development, slice by slice |
| [docs/verification-engineer.md](docs/verification-engineer.md) | The final end-to-end verification session notes |
| [docs/handoff/](docs/handoff/) | The per-task handoff files (goal, what exists, definition of done) |

## Stack

TanStack Start (React 19 + Vite 7 + Tailwind 4) · TypeScript · Postgres (plain SQL migrations, no
ORM) · Bun. All database access lives in server functions (`createServerFn`) — no DB access from
client code. No dependencies beyond the framework, React, and `pg` / `@neondatabase/serverless`.
