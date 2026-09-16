# Task 06 — Housekeeping and owner decisions

Not a build task — the loose ends and the choices only the owner can make.

## A. GitHub sync — DONE (2026-09-16)

The full tree (app + migrations + scripts + complete `docs/` set: architecture, runbook,
verification, handoff) is pushed to `donnieladd/growthbyform`, branch `main`, commit `3b641fc`. The
remote's only prior content was GitHub's auto-generated placeholder README (`# growthbyform`), which
the real README replaced via force-push — nothing of value was lost. The tree's `.gitignore`
excludes `node_modules`, `dist`, `.run`, `.tanstack`, and the generated `routeTree.gen.ts`.

Going forward: pull before work, commit to `main`, push after (see WORKFLOW.md).

## B. Demo credentials must be rotated before real people

`pastor@demo.church / growthtrack-demo` and `coach@demo.church / growthtrack-demo` are real passwords
on a real login form in the demo tenant. Before the pilot church holds real data: change or delete
these accounts (`SEED_STAFF_PASSWORD` env var overrides the demo password at seed time). Flag for the
owner.

## C. Decisions only the owner can make (from the business plan)

1. **Pilot incentive** — what we offer the pilot church (free period, discounted rate, design-partner
   input). Should be settled before approaching a church; pricing isn't scoped yet (task 05 feeds it).
2. **Plan ratification** — plan revision 3 is the team's working update, not owner-endorsed. The owner
   should review/ratify on the Plan tab.
3. **Stripe / finance** — the business cannot take payments until finance is set up on the Finance
   tab. Not blocking the MVP, blocking revenue.

## D. Deliberately out of scope (so nobody wanders in)

Small groups platform, message amplification, member app/portal, Planning Center or Monday.com sync,
our own SMS/email sending, the full automation runtime, billing. Also unbuilt but listed in engineer
notes: editing a person, merging flagged duplicates, reassigning coaches via UI (assignment is a data
field today).
