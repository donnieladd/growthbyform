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

export const getSetupState = createServerFn({ method: "GET" }).handler(
  async (): Promise<SetupState> => {
    const { readSetupState } = await import("./setup-core");
    return readSetupState();
  },
);

/** Where + what the connection points at, for display. Never includes secrets. */
export const getConnectionInfo = createServerFn({ method: "GET" }).handler(
  async (): Promise<ConnectionInfo> => {
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
