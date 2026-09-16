// Migration runner.
//
//   bun run db:migrate           apply every pending migration in db/migrations
//   bun run db:status            show applied / pending without changing anything
//
// Plain SQL files in filename order, each applied inside one transaction, each
// recorded in schema_migrations with a checksum so a later edit to an already
// applied file is reported instead of silently drifting.
//
//   DATABASE_URL=postgres://user:pass@host:5432/db bun run db:migrate
//
// Any standard Postgres connection string works. Read DATABASE_URL from the
// environment only — never from a .env file, which is not published.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { closePool } from "../src/lib/pg";

const { Pool } = pg;

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, "..", "db", "migrations");
// One runner at a time, even across processes.
const ADVISORY_LOCK_KEY = 918_273_645;

const BOOTSTRAP_SQL = `
create table if not exists schema_migrations (
  filename   text primary key,
  checksum   text not null,
  applied_at timestamptz not null default now()
)`;

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

async function migrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((name) => name.endsWith(".sql")).sort();
}

function maskUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error(
      [
        "DATABASE_URL is not set.",
        "",
        "Set it in the environment (Settings → Secrets on the platform) and run this again:",
        "  DATABASE_URL=postgres://user:password@host:5432/database bun run db:migrate",
        "",
        "Nothing was changed.",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  const statusOnly = process.argv.includes("--status");
  const files = await migrationFiles();
  const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 10_000 });
  const client = await pool.connect();

  try {
    const { rows: versionRows } = await client.query<{ version: string }>("select version() as version");
    console.log(`Target: ${maskUrl(url)}`);
    console.log(`Server: ${versionRows[0].version.split(" on ")[0]}`);

    await client.query(BOOTSTRAP_SQL);
    const { rows: appliedRows } = await client.query<{ filename: string; checksum: string }>(
      "select filename, checksum from schema_migrations",
    );
    const applied = new Map(appliedRows.map((r) => [r.filename, r.checksum]));

    const pending: string[] = [];
    for (const filename of files) {
      const sqlText = await readFile(path.join(MIGRATIONS_DIR, filename), "utf8");
      const sum = checksum(sqlText);
      const recorded = applied.get(filename);
      if (recorded && recorded !== sum) {
        console.warn(
          `! ${filename} has changed since it was applied (checksum mismatch). Add a new migration instead of editing an applied one.`,
        );
      }
      if (!recorded) pending.push(filename);
    }

    console.log(`\nMigrations: ${String(applied.size)} applied, ${String(pending.length)} pending`);
    for (const filename of files) {
      console.log(`  ${applied.has(filename) ? "applied" : "pending"}  ${filename}`);
    }

    if (statusOnly) return;

    if (pending.length === 0) {
      console.log("\nNothing to apply.");
      return;
    }

    console.log("");
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK_KEY]);
    try {
      for (const filename of pending) {
        const sqlText = await readFile(path.join(MIGRATIONS_DIR, filename), "utf8");
        const started = Date.now();
        await client.query(sqlText);
        await client.query("insert into schema_migrations (filename, checksum) values ($1, $2)", [
          filename,
          checksum(sqlText),
        ]);
        console.log(`  applied ${filename} (${String(Date.now() - started)}ms)`);
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    }

    const { rows: tableRows } = await client.query<{ count: string }>(
      `select count(*)::text as count from information_schema.tables where table_schema = 'public'`,
    );
    console.log(`\nDone. ${String(pending.length)} migration(s) applied; ${tableRows[0].count} tables in public.`);
    console.log("Next: bun run db:seed  (church, staff account, seven stages, demo people)");
  } finally {
    client.release();
    await pool.end();
  }
}

main()
  .catch((err: unknown) => {
    console.error("\nMigration failed — nothing from the failing file was kept.");
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
