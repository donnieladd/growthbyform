// Server-only implementation of the setup/health view. Imported only from
// server-fn handlers (dynamically), so none of this reaches the client bundle:
// it reads the filesystem to compare migration files on disk with schema_migrations.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { checkDatabase, query } from "../lib/pg";
import type { SetupState, MigrationFile } from "./setup";

function migrationsDir(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "db", "migrations"),
    // The built server lives in dist/server/, so walk back to the site root.
    path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..", "db", "migrations"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

function migrationFiles(): string[] {
  const dir = migrationsDir();
  if (!dir) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((name: string) => name.endsWith(".sql"))
      .sort();
  } catch {
    return [];
  }
}

export async function readSetupState(): Promise<SetupState> {
  const files = migrationFiles();
  const database = await checkDatabase();
  const applied = new Set(database.appliedMigrations ?? []);
  const migrations: MigrationFile[] = files.map((filename) => ({
    filename,
    applied: applied.has(filename),
  }));

  const seed = {
    configured: false,
    church: null as string | null,
    churches: 0,
    staffUsers: 0,
    stages: 0,
    people: 0,
  };
  if (database.reachable && database.migrated) {
    try {
      const [counts] = await query<{
        churches: string;
        staff_users: string;
        stages: string;
        people: string;
      }>(
        `select
           (select count(*) from churches) as churches,
           (select count(*) from staff_users) as staff_users,
           (select count(*) from growth_track_stages) as stages,
           (select count(*) from persons) as people`,
      );
      const [first] = await query<{ name: string }>(
        `select name from churches order by created_at asc limit 1`,
      );
      seed.churches = Number(counts?.churches ?? 0);
      seed.staffUsers = Number(counts?.staff_users ?? 0);
      seed.stages = Number(counts?.stages ?? 0);
      seed.people = Number(counts?.people ?? 0);
      seed.church = first?.name ?? null;
      seed.configured = seed.churches > 0 && seed.staffUsers > 0 && seed.stages > 0;
    } catch {
      seed.configured = false;
    }
  }

  return {
    database,
    migrations,
    pendingMigrations: migrations.filter((m) => !m.applied).map((m) => m.filename),
    seed,
    ready: database.reachable && database.migrated && seed.configured,
  };
}
