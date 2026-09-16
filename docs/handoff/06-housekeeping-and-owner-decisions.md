# Task 06 — Housekeeping and owner decisions

Not a build task — the loose ends and the choices only the owner can make.

## A. GitHub sync (outstanding, lead-owned)

The deploy tree has no working git repo (an earlier attempt to push failed and left no `.git`). The
linked remote `donnieladd/growthbyform` contains only an initial README, so the sync is
conflict-free. Run from a lead/main session (NOT during a code delegation):

```bash
cd /home/team/shared/site
git init -b main
git add -A
git commit -m "Growth Track MVP: slices 1-2 (spine, capture, pipeline board, stall detection)"
git remote add origin https://github.com/donnieladd/growthbyform.git
git fetch origin main
git pull --rebase origin main   # remote has only a README
git push -u origin main
```

Check for a leftover rebase state first (`ls .git/rebase-merge .git/rebase-apply` → remove if present
before init; if `git init` is refused because the dir exists, just resume from `git add`). Get fresh
GitHub credentials via the lead's `get_git_credentials` tool before pushing if auth fails.
Afterwards update `/home/team/shared/WORKFLOW.md` — its "Version control" section currently says the
tree is not a repo; once the sync lands, keep it current (pull before work, push after).

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
