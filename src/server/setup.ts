// Honest setup state.
//
// With no DATABASE_URL the app must still build and serve, and say plainly that it
// is not wired up yet — never invent demo rows or run a parallel mock data path.
// Everything that reads data returns this shape first so every page can degrade the
// same way.

import { createServerFn } from "@tanstack/react-start";
import type { DatabaseHealth } from "../lib/pg";

export type MigrationFile = { filename: string; applied: boolean };

export type SetupState = {
  database: DatabaseHealth;
  /** Migration files on disk vs. rows in schema_migrations. */
  migrations: MigrationFile[];
  pendingMigrations: string[];
  seed: {
    configured: boolean;
    church: string | null;
    churches: number;
    staffUsers: number;
    stages: number;
    people: number;
  };
  ready: boolean;
};

export type ConnectionInfo =
  | { configured: false }
  | {
      configured: true;
      host: string;
      database: string;
      tls: string;
      driver: string;
    };

// Both functions below are reachable as HTTP endpoints directly, not just from the
// rendered /setup page — so both must gate on the same thing: is this instance
// still pre-configured (no church/staff seeded yet, the exact case /setup exists
// to serve with zero auth), or does real church data already exist? Once
// seed.configured is true, an unauthenticated caller gets a redacted view instead
// of church name, people/staff counts, or DB host details.

async function isStaffAuthenticated(): Promise<boolean> {
  const [{ getCookie }, { requireStaff }] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("./auth-core"),
  ]);
  const { SESSION_COOKIE } = await import("../lib/session-constants");
  const auth = await requireStaff(getCookie(SESSION_COOKIE));
  return auth.ok;
}

export const getSetupState = createServerFn({ method: "GET" }).handler(
  async (): Promise<SetupState> => {
    const { readSetupState } = await import("./setup-core");
    const state = await readSetupState();
    if (!state.seed.configured) return state;
    if (await isStaffAuthenticated()) return state;
    return {
      ...state,
      seed: { ...state.seed, church: null, churches: 0, staffUsers: 0, stages: 0, people: 0 },
    };
  },
);

/** Where + what the connection points at, for display. Never includes secrets. */
export const getConnectionInfo = createServerFn({ method: "GET" }).handler(
  async (): Promise<ConnectionInfo> => {
    const { readSetupState } = await import("./setup-core");
    const state = await readSetupState();
    if (state.seed.configured && !(await isStaffAuthenticated())) {
      return { configured: false };
    }
    const { databaseUrl, describeDatabaseUrl } = await import("../lib/pg");
    const url = databaseUrl();
    if (!url) return { configured: false };
    const described = describeDatabaseUrl(url);
    return {
      configured: true,
      host: described.host,
      database: described.database,
      tls: described.needsSsl ? "yes (sslmode in connection string)" : "no (local connection)",
      driver: process.env.DB_DRIVER === "neon-http" ? "neon-http (src/db.ts)" : "node-postgres over TCP",
    };
  },
);
