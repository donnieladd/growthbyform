# Runbook

Everything needed to run, verify, build, and deploy the app.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | To store anything | Standard Postgres URL. Read from `process.env` **only** — never a `.env` file (`.env` files are not published, so a value living only there silently disappears on the live site). |
| `DB_DRIVER` | No | Set to `neon-http` to switch back to the original Neon HTTP helper in `src/db.ts`. Default uses `pg` over TCP. |
| `PUBLIC_CHURCH_SLUG` | No | Only matters when more than one church exists. |
| `SEED_STAFF_PASSWORD` | No | Overrides the demo staff password at seed time. |
| `COOKIE_SECURE` | Set to `true` once real production TLS is confirmed | Controls the session cookie's `Secure` flag. Unset falls back to sniffing `x-forwarded-proto`, which only a trusted TLS-terminating proxy can be relied on to set honestly — a client can otherwise spoof that header. Set explicitly to `true` on real production deploys, `false` for plain-http local/dev. |

## Commands

```bash
cd /home/team/shared/site
bun install
bun run db:migrate      # apply pending migrations (0001, 0002, 0003)
bun run db:status       # show applied / pending migrations only
bun run db:seed         # demo church + 2 staff + 7 stages + 11 demo people
bun run db:seed -- --reset   # REBUILD demo data from scratch (wipes and reseeds)
bun run db:verify       # 50+ automated checks; intrusive probes roll themselves back
bun run build           # production build: client bundle + SSR (must pass)
bun run dev             # dev server (hot reload)
bun run start           # serve the production build
bun run format          # prettier
```

Migration files live in `db/migrations/` and are plain SQL, applied in order and tracked in
`schema_migrations`. **Never mutate the schema by hand** — add a migration file. Never edit an
already-applied migration; the runner's contract requires new fixes as new files (see the 0002 → 0003
bug-fix story in ARCHITECTURE.md).

## Serving topology (as deployed here)

- The deploy source **is** the live tree: `/home/team/shared/site`. There is no second copy.
- A platform-managed server serves the working/preview site on **port 3000** and hot-reloads edits.
  **Never restart or kill it** — refresh instead.
- The **live public site** is swapped by the platform's publish step (`publish_site` on the lead
  side, or the SITE tab's Publish button). Nothing is public until a publish succeeds.
- `bun run go-live` (→ `go-live.sh`) is for external hosting (Vercel) and is not the current path.

## ⚠️ Known environment caveat — the port-3000 process and `DATABASE_URL`

As of 2026-09-16 the long-running managed server on port 3000 was started **before** `DATABASE_URL`
existed, and its process environment does not contain it (verified via `/proc/<pid>/environ`: 0
matches for the :3000 pids, 1 for ad-hoc dev servers started from a shell, which do inherit it).
Symptom: the connect card on :3000 renders "This card cannot save anything yet — DATABASE_URL is not
set" and rejects submissions.

Everything else about the database connection is fine: the shell environment has the variable, the
production database is migrated and seeded, and any dev server started normally (`bun run dev` /
`bun run start`) connects and works — that is how the end-to-end verification was run (port 3100,
same tree, same database).

**Fix options, in order of preference:**
1. Owner re-saves `DATABASE_URL` in Settings → Secrets (the platform route: secrets reach both
   environments and take effect within seconds without a republish).
2. Trigger a fresh serving process — a successful publish may restart the managed server with the
   current environment; test the connect card immediately afterwards.
3. Worst case: restart the machine (files survive; the managed server starts fresh and inherits the
   shell environment).

**Do not publish until the connect card on the public URL actually saves** — a publish that ships a
card that cannot save is a bad first impression for a pilot church.

## Deployment checklist (publish)

1. `bun run build` green.
2. `bun run db:verify` green against the target database.
3. Decide whether to reseed first (`bun run db:seed -- --reset`) so the public site starts from
   clean demo data — this wipes test persons (e.g. TEST-Veronica Ashby) and rebuilds the 11 demo
   people. Reseed AFTER the serving process can reach the database.
4. Publish, then click the full flow on the **public** URL (see VERIFICATION.md) — not localhost.
5. Demo credentials on a public site: acceptable for a fictional demo tenant; rotate before real
   people are entered (`SEED_STAFF_PASSWORD`, or delete/recreate the seeded staff accounts).
