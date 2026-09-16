# E2E verification run — 2026-09-16 (engineer session)

Status: MVP flow works end to end **when the server process has DATABASE_URL**.
No application code was changed in this run — the flow held up under clicking.

## Where I ran it, and why it matters for publish

- The platform-managed dev server on port 3000 runs **without DATABASE_URL** in its
  process environment. Evidence: `tr '\0' '\n' < /proc/<pid>/environ | grep -c
  '^DATABASE_URL='` returns `0` for the vite processes serving :3000 (pids 184, 271)
  and `1` for the vite processes serving :3100 (pids 9647, 9649). The /connect page on
  :3000 renders the "This card cannot save anything yet / DATABASE_URL is not set"
  notice and a submission returns "That did not save — DATABASE_URL is not set."
  DATABASE_URL lives in `/etc/profile.d/*.sh` (`export DATABASE_URL=...`) and
  `/etc/profile.d/cto-env-vars.sh` only exports TEAM_DB_EVENTS_*/IMAGE_UPLOAD_* — the
  server is started by a watchdog that does not source the profile, so the secret
  never reaches the serving process.
- A second dev server on the same tree (port 3100) **does** have DATABASE_URL, so all
  clicking below was done against `localhost:3100`. Same files, same Postgres.
- **Publish implication:** until the :3000 managed process receives DATABASE_URL, the
  published site will ship a connect card that cannot save. This is an environment
  wiring issue, not app code. The lead needs to make DATABASE_URL available to the
  managed server process (platform Secrets is the clean route) — do not kill/restart
  the managed server from a shell.

## What I clicked and saw (all against localhost:3100, real Chromium)

1. **Connect card, new guest** — filled first/last/email/phone/address/howHeard,
   submitted. Result: "First visit recorded / New record created / Thank you,
   TEST-Veronica / You are on the track at: First-Time Guest".
   DB: persons row created via `connect_card`, `visit_count=1`, stage First-Time Guest,
   a household was created, `connect_card_submissions.visit_report='first_time'`,
   `matched_on='no_match_created'`.
2. **Near-duplicate** — same phone, different email, "I have been before". Result:
   "Visit #2 recorded / Second visit — strongest signal / Matched an existing record".
   DB: same person id, `visit_count=2`, one new visit row with
   `visit_report='returning'`, `matched_on='phone_e164'`. No duplicate person.
3. **Staff auth** — signed in at /login with `pastor@demo.church` /
   `growthtrack-demo` → redirected to /staff showing DEMO COMMUNITY CHURCH, Dana Reyes,
   12 people, 5 overdue.
4. **Pipeline board** — 7 stage columns with people; moved TEST-Veronica forward to
   Returning Guest on the card's "Move to stage" + Move control, then back to
   First-Time Guest. DB shows three `stage_history` rows:
   (system → First-Time Guest), (First-Time Guest → Returning Guest, Dana Reyes,
   "Moved on the pipeline board", `staff_entry`), (Returning Guest → First-Time Guest,
   same actor). `persons.stage_changed_at` updated each time.
5. **Stall detection** — /staff/tasks shows "5 people are past their stage's expected
   dwell" with Everyone (5) / My people (3) and rows Jonah Kim 45/21 (24 over),
   Nia Johnson 44/28 (16), Sam Whitfield 21/14 (7), Marcus Webb 34/28 (6),
   Tom Becker 12/7 (5) — identical to the `person_stage_clock` view. The fresh
   TEST-Veronica card reads "On pace / today of 7" and is absent from the task list.

## Not verified / gaps

- **Recording a decision event from the UI is not possible — the feature does not
  exist.** `/staff/people/$id` is read-only (the page says so, and there is no
  `recordDecisionEvent` server function anywhere in `src/`). Seeded decision events
  (4) render on the timeline with the person's stage-at-the-time and the note that a
  decision never moves anybody; repeatability/separateness is structural
  (`decision_events` is its own table with occurrence vs. recorded timestamps) but
  was **not** exercised by clicking, because there is no way to create one from the UI.
  This is the one item of the brief that could not be verified.
- The connect card at :3000 cannot save (see above), so the flow was not verified on
  the port the published site uses.

## Housekeeping

- Test data left in the production DB on purpose so the lead can inspect it:
  person **TEST-Veronica Ashby** (phone +15125550701, household "The Ashbys Household"),
  2 visits, 1 connect-card submission pair, 3 stage_history rows. Remove with:
  `delete from persons where last_name='Ashby' and first_name like 'TEST%';`
  (cascades cover visits/submissions/history).
- `bun run build` is green (`EXIT=0`, client + SSR). No files in the site tree were
  modified by this run.

## Browser-driver quirk (not an app bug)

With agent-browser, a synthetic click on the submit button after a radio/select
interaction can fail to reach React's onSubmit (the form just sits there with no
error). Driving the same submit with `form.requestSubmit()` in the page, and changing
a controlled `<select>` with the native value setter + a bubbling `change` event, both
work. Use those when a click appears to do nothing.
