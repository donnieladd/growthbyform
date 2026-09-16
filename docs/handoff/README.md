# Handoff — Growth Track by Form

**Written:** 2026-09-16, by the team lead (CTO agent). **Purpose:** complete handoff package for a
separate agent taking over the remaining work. Read this file first, then the numbered task files.

## What this business is

A ministry operating system for the one pipeline a church can't afford to lose:
first-time visitor → fully deployed, relationally-cared-for member. One Person record and one
continuous stage timeline every part of the church reads from and writes to. SaaS, sold per church,
starting with one pilot church. The **business plan** (revisions, current focus, decisions) is the
authoritative strategy doc — held by the lead agent and shown on the Plan tab; strategy questions go
there, not to working notes.

## Current state (as of handoff)

- **Database: connected and live.** `DATABASE_URL` is set in the environment (owner connected it via
  the DB card). Production Postgres has all migrations applied and demo seed data:
  1 church, 11 persons, 7 stages, 2 staff users, 11 stage-history rows, 4 decision events.
- **Slices 1 and 2: built and verified.** The spine (14 tables, in-house staff auth, connect card
  with identity resolution), the pipeline board, stall detection, the coach task list, contact
  logging, coach assignment, and the read-only person record. ~50 automated checks pass
  (`bun run db:verify`); build green; real-browser screenshots of the board and task list exist.
- **Capture verified in a real browser against the production DB** (2026-09-16, just before handoff):
  a test guest submitted on `/connect` created a person at First-Time Guest; a near-duplicate
  submission (different email, same phone) resolved to the SAME person — visit #2 recorded,
  matched on `phone_e164`, no duplicate row.
- **Not yet done:** clicking Move / log-contact on the live site, decision-event UI (slice 3),
  publish, GitHub sync. See the task files.
- **Roster:** engineer finishing a final verification pass at handoff time, then stopped. No other
  members. Hire as the remaining work requires (`add_member`, grant `code-access` for code work).

## Where things live

| Path | What it is |
| --- | --- |
| `/home/team/shared/site` | The app — **both source of truth and deploy source**. TanStack Start (React 19 + Vite + Tailwind 4), port 3000. |
| `/home/team/shared/site/SITE.md` | Authoritative on how the site is served and shipped. |
| `/home/team/shared/WORKFLOW.md` | Team code workflow — read before any code task. |
| `/home/team/shared/growth-track/ENGINEER-NOTES.md` | Fully updated build notes: schema, commands, what was verified, flags. Excellent context. |
| `/home/team/shared/handoff/` | This folder — the remaining work. |

## Ground rules (non-negotiable, learned the hard way)

1. **No git commands in `/home/team/shared/site`** unless the GitHub sync (task 06) is being done
   deliberately — the tree is the live deploy source.
2. **Never write a `.env` file.** Secrets come from `process.env` only; `.env` doesn't publish.
3. **Never restart or kill the platform-managed server** on port 3000 — it hot-reloads edits.
4. **The lead publishes** (`publish_site` tool) — members never run `publish.sh`.
5. **Verification standard:** every code task ends with real-browser verification against a real
   database — clicking the flow, not just asserting SQL. Reports state what was verified with actual
   observations, what was NOT verified, and what remains.
6. Reports and notes in English.
7. `DATABASE_URL` reaches the published site automatically; saving a new value there takes effect
   within seconds, no republish needed.

## Task index

| File | Backlog id | Status |
| --- | --- | --- |
| `01-finish-e2e-verification.md` | 5a6304fa | In progress — capture verified; interactions click-through pending |
| `02-slice-3-decision-events.md` | e32ce51d | Not started (table + display exist; UI to record does not) |
| `03-publish-and-verify-live.md` | c68082ab | Blocked on 01 |
| `04-self-serve-track-configuration.md` | 06f86091 | Not started (DB-level validation exists; UI does not) |
| `05-pricing-research.md` | 05271c23 | Not started (needs web access) |
| `06-housekeeping-and-owner-decisions.md` | — | GitHub sync outstanding; owner decisions listed |

Backlog ids are stable — quote them when completing/reordering items via the lead's `backlog` tool.
