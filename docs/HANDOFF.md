# Handoff — remaining work

Everything below is unstarted or partially done. Detailed per-task briefs (goal, what already
exists, definition of done) live in [docs/handoff/](handoff/) — read the one you pick up. Backlog ids
are stable identifiers for the owner's board.

## 1. Finish end-to-end verification — `5a6304fa`

Capture is **verified in a real browser against the production DB** (new guest, near-duplicate
resolution by phone). Remaining: click staff login, a pipeline move + back (checking the
`stage_history` audit row), the task list + contact logging, and the person record — see
[handoff/01](handoff/01-finish-e2e-verification.md). Blocked only by the port-3000 environment issue
(RUNBOOK.md); any dev server with `DATABASE_URL` works today.

## 2. Slice 3: decision events in the UI — `e32ce51d`

The `decision_events` table, seed data, and read-only timeline display exist. What's missing: a
"Log decision" control on the person page (kind, date, note), a server function, and the guarantee
that recording one never moves stage or clock. Brief: [handoff/02](handoff/02-slice-3-decision-events.md).

## 3. Publish and verify the live public URL — `c68082ab`

The last step to a clickable MVP to show a prospective pilot church. **Gate:** fix the port-3000
`DATABASE_URL` issue first (RUNBOOK.md), then publish (a lead/platform action), then click the full
flow on the **public** URL. Brief: [handoff/03](handoff/03-publish-and-verify-live.md).

## 4. Self-serve track configuration — `06f86091`

Database-level validation exists (`validate_growth_track_config()` refuses missing required
checkpoints, Belonging not first, Deployment before Self-understanding). Missing: the staff-facing
config screen with readable refusal messages and safe stage renames. Brief:
[handoff/04](handoff/04-self-serve-track-configuration.md).

## 5. Pricing research — `05271c23`

What Planning Center, Church Community Builder, Breeze, Rock, Tithe.ly (and comparable) charge per
church and what that includes — the input to our first pricing model. Needs web access. Brief:
[handoff/05](handoff/05-pricing-research.md).

## Housekeeping

- **GitHub sync** (this push) — after it lands, update the team workflow doc: the deploy tree now
  has a git repo; future flow is pull before work, push after.
- **Demo credentials** (`pastor@demo.church` / `coach@demo.church`, password `growthtrack-demo`) are
  real passwords on a real login form. Rotate or delete before any real church data
  (`SEED_STAFF_PASSWORD`, or recreate the accounts).
- **Test person** TEST-Veronica Ashby is in the production DB deliberately — clean up per
  VERIFICATION.md before showing a church, or reseed.

## Decisions reserved for the owner

1. **Pilot incentive** (free period / discount / design-partner input) — settle before approaching a
   church; pricing isn't scoped yet (item 5 feeds it).
2. **Ratifying the business plan** — the current plan revision is the team's working update.
3. **Stripe / finance setup** — the business cannot take payments until finance is connected. Not
   blocking the MVP; blocking revenue.
