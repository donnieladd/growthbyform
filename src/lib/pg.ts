// Server-only Postgres access for Growth Track.
//
// Why not src/db.ts: that helper is the Neon serverless HTTP driver, which only
// works against a Neon host. The owner may connect any standard Postgres, so data
// access here goes over TCP with node-postgres, which works against Neon,
// Supabase, RDS and a local box alike. src/db.ts is left intact for compatibility.
//
// The driver is chosen from the connection string (with an explicit override):
//   * default            -> node-postgres over TCP (transactions, any provider)
//   * DB_DRIVER=neon-http -> the original serverless helper in src/db.ts
// Read `DATABASE_URL` from process.env only. Never write a .env file: .env files
// are not published, so a value that only lives there is missing on the live site.
//
// Import this ONLY from server code (createServerFn handlers, route loaders that
// run on the server, or the scripts/ migration + seed CLI). Never from a component.

import pg from "pg";
import type { PoolClient } from "pg";

export type DbDriver = "pg" | "neon-http";

export class DbUnavailableError extends Error {
  readonly reason: "not-configured" | "unreachable" | "query-failed";
  constructor(reason: DbUnavailableError["reason"], message: string, cause?: unknown) {
    super(message);
    this.name = "DbUnavailableError";
    this.reason = reason;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export function databaseUrl(): string | null {
  const raw = process.env.DATABASE_URL;
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function dbDriver(): DbDriver {
  return process.env.DB_DRIVER === "neon-http" ? "neon-http" : "pg";
}

/** Host + database for display. Never returns credentials. */
export function describeDatabaseUrl(url: string): { host: string; database: string; needsSsl: boolean } {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      database: parsed.pathname.replace(/^\//, "") || "(default)",
      needsSsl: /sslmode=(require|verify)/.test(parsed.search) || !/^(localhost|127\.0\.0\.1|\[::1\])/.test(parsed.hostname),
    };
  } catch {
    return { host: "(unparseable DATABASE_URL)", database: "(unknown)", needsSsl: true };
  }
}

let pool: pg.Pool | null = null;
let poolFor: string | null = null;

export function getPool(): pg.Pool {
  const url = databaseUrl();
  if (!url) {
    throw new DbUnavailableError(
      "not-configured",
      "DATABASE_URL is not set — connect a database (Settings → Secrets) and the app will pick it up on the next request.",
    );
  }
  if (!pool || poolFor !== url) {
    if (pool) void pool.end().catch(() => undefined);
    // The connection string carries its own sslmode (Neon, Supabase and RDS all
    // hand one out). Passing it through untouched means pg honours the provider's
    // instruction rather than us guessing about TLS.
    pool = new pg.Pool({
      connectionString: url,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: "growth-track",
    });
    poolFor = url;
    // A pool-level error listener keeps one dropped socket from taking the process
    // down; the next query opens a fresh connection.
    pool.on("error", () => undefined);
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  try {
    const res = await getPool().query<T>(text, params as never[]);
    return res.rows;
  } catch (err) {
    throw wrapDbError(err);
  }
}

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } catch (err) {
    throw wrapDbError(err);
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const out = await fn(client);
      await client.query("commit");
      return out;
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    }
  });
}

export function wrapDbError(err: unknown): Error {
  if (err instanceof DbUnavailableError) return err;
  const e = err as { code?: string; message?: string };
  const message = e?.message ?? String(err);
  if (
    e?.code === "ECONNREFUSED" ||
    e?.code === "ENOTFOUND" ||
    e?.code === "ETIMEDOUT" ||
    e?.code === "EHOSTUNREACH" ||
    /timeout/i.test(message)
  ) {
    return new DbUnavailableError("unreachable", `Cannot reach the database: ${message}`, err);
  }
  // Anything else is a real error from the database (bad SQL, missing table, a
  // constraint) or from the caller's own code. Pass it through untouched — callers
  // distinguish "cannot reach the database" from "that query failed", and wrapping
  // everything would hide both.
  return err instanceof Error ? err : new Error(message);
}

/** Close the shared pool. Scripts call this so their process can exit. */
export async function closePool(): Promise<void> {
  const current = pool;
  pool = null;
  poolFor = null;
  if (current) await current.end().catch(() => undefined);
}

export type DatabaseHealth = {
  configured: boolean;
  reachable: boolean;
  migrated: boolean;
  migratedTables: number;
  expectedTables: number;
  serverVersion?: string;
  host?: string;
  database?: string;
  appliedMigrations?: string[];
  pendingMigrations?: { filename: string }[];
  error?: { reason: DbUnavailableError["reason"] | "missing-tables"; message: string };
};

/** Tables the spine is not usable without. Used to answer "is this database set up?" */
export const REQUIRED_TABLES = [
  "churches",
  "staff_users",
  "staff_sessions",
  "growth_track_configs",
  "growth_track_stages",
  "households",
  "persons",
  "person_visits",
  "connect_card_submissions",
  "step_completions",
  "decision_events",
  "stage_history",
  "person_interactions",
] as const;

export async function checkDatabase(): Promise<DatabaseHealth> {
  const url = databaseUrl();
  const known = REQUIRED_TABLES.length;
  if (!url) {
    return {
      configured: false,
      reachable: false,
      migrated: false,
      migratedTables: 0,
      expectedTables: known,
      error: {
        reason: "not-configured",
        message:
          "No database is connected yet. Add DATABASE_URL in Settings → Secrets and this page will pick it up within seconds.",
      },
    };
  }

  const described = describeDatabaseUrl(url);
  try {
    const [version] = await query<{ version: string }>("select version() as version");
    const tables = await query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name = any($1::text[])`,
      [REQUIRED_TABLES as unknown as string[]],
    );
    let applied: string[] = [];
    let hasMigrationTable = false;
    try {
      const rows = await query<{ filename: string }>(
        "select filename from schema_migrations order by filename",
      );
      applied = rows.map((r) => r.filename);
      hasMigrationTable = true;
    } catch {
      hasMigrationTable = false;
    }
    return {
      configured: true,
      reachable: true,
      migrated: tables.length === known,
      migratedTables: tables.length,
      expectedTables: known,
      serverVersion: version?.version,
      host: described.host,
      database: described.database,
      appliedMigrations: applied,
      pendingMigrations: hasMigrationTable ? [] : undefined,
    };
  } catch (err) {
    const wrapped = wrapDbError(err);
    return {
      configured: true,
      reachable: false,
      migrated: false,
      migratedTables: 0,
      expectedTables: known,
      host: described.host,
      database: described.database,
      error: { reason: wrapped.reason, message: wrapped.message },
    };
  }
}
