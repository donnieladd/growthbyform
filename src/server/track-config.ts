// Self-serve track configuration — HANDOFF item 4
// (docs/handoff/04-self-serve-track-configuration.md).
//
// The DB already refuses a broken track (validate_growth_track_config(),
// 0002_rules_and_triggers.sql) — this module is the write path on top of it,
// not a second copy of the rule. Every save runs inside one transaction:
// apply the edits, call the validator, and either commit or roll the whole
// thing back and hand the church back its own readable refusal reasons.
//
// Renaming a stage is always safe: the row's id never changes, so
// stage_history, persons.current_stage_id and step_completions — all of
// which point at that id, never at the name — stay coherent. Deleting a
// stage that anyone has ever passed through is refused by the database's own
// foreign-key constraints (growth_track_stages has no ON DELETE CASCADE from
// those tables on purpose); this module catches that refusal and turns it
// into a readable message instead of a raw constraint error.

import { createServerFn } from "@tanstack/react-start";
import { SESSION_COOKIE } from "../lib/session-constants";

export const CHECKPOINT_KINDS = ["belonging", "self_understanding", "leadership_character", "deployment"] as const;
export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];

export const CADENCE_VALUES = ["weekly", "monthly", "fast_track"] as const;
export type Cadence = (typeof CADENCE_VALUES)[number];

export const DELIVERY_MODES = ["sequential", "flexible"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export type TrackStage = {
  id: string;
  name: string;
  description: string | null;
  sequence: number;
  expectedDwellDays: number | null;
  isTerminal: boolean;
  checkpointKind: CheckpointKind | null;
  peopleCount: number;
};

export type TrackConfigResult =
  | {
      state: "ok";
      churchName: string;
      config: {
        id: string;
        name: string;
        cadence: Cadence;
        deliveryMode: DeliveryMode;
        requiresBelonging: boolean;
        requiresSelfUnderstanding: boolean;
        allowsLeadershipCharacter: boolean;
        requiresDeployment: boolean;
      };
      stages: TrackStage[];
      validation: { isValid: boolean; errors: string[] };
    }
  | { state: "forbidden" }
  | { state: "unauthenticated" }
  | { state: "setup-required"; message: string };

export const getTrackConfig = createServerFn({ method: "GET" }).handler(async (): Promise<TrackConfigResult> => {
  const [{ getCookie }, { requireStaff }, { query }] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("./auth-core"),
    import("../lib/pg"),
  ]);

  const auth = await requireStaff(getCookie(SESSION_COOKIE));
  if (!auth.ok) {
    if (auth.state === "db-unavailable") {
      return { state: "setup-required", message: auth.message ?? "The database is not reachable." };
    }
    return { state: "unauthenticated" };
  }
  if (auth.session.role !== "owner") {
    return { state: "forbidden" };
  }

  const [config] = await query<{
    id: string;
    name: string;
    cadence: Cadence;
    delivery_mode: DeliveryMode;
    requires_belonging: boolean;
    requires_self_understanding: boolean;
    allows_leadership_character: boolean;
    requires_deployment: boolean;
  }>(
    `select id, name, cadence, delivery_mode, requires_belonging, requires_self_understanding,
            allows_leadership_character, requires_deployment
       from growth_track_configs
      where church_id = $1 and is_active`,
    [auth.session.churchId],
  );
  if (!config) {
    return { state: "setup-required", message: "This church has no active growth track configuration yet." };
  }

  const stages = await query<{
    id: string;
    name: string;
    description: string | null;
    sequence: number;
    expected_dwell_days: number | null;
    is_terminal: boolean;
    checkpoint_kind: CheckpointKind | null;
    people_count: string;
  }>(
    `select s.id, s.name, s.description, s.sequence, s.expected_dwell_days, s.is_terminal, s.checkpoint_kind,
            (select count(*) from persons p where p.current_stage_id = s.id) as people_count
       from growth_track_stages s
      where s.config_id = $1
      order by s.sequence`,
    [config.id],
  );

  const [validation] = await query<{ is_valid: boolean; errors: string[] }>(
    `select is_valid, errors from validate_growth_track_config($1)`,
    [config.id],
  );

  return {
    state: "ok",
    churchName: auth.session.churchName,
    config: {
      id: config.id,
      name: config.name,
      cadence: config.cadence,
      deliveryMode: config.delivery_mode,
      requiresBelonging: config.requires_belonging,
      requiresSelfUnderstanding: config.requires_self_understanding,
      allowsLeadershipCharacter: config.allows_leadership_character,
      requiresDeployment: config.requires_deployment,
    },
    stages: stages.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      sequence: s.sequence,
      expectedDwellDays: s.expected_dwell_days,
      isTerminal: s.is_terminal,
      checkpointKind: s.checkpoint_kind,
      peopleCount: Number(s.people_count),
    })),
    validation: { isValid: validation?.is_valid ?? false, errors: validation?.errors ?? [] },
  };
});

export type SaveStageInput = {
  id: string | null;
  name: string;
  description: string;
  expectedDwellDays: number | null;
  isTerminal: boolean;
  checkpointKind: CheckpointKind | null;
};

export type SaveTrackConfigResult =
  | { state: "ok"; message: string }
  | { state: "invalid"; errors: string[] }
  | { state: "forbidden" }
  | { state: "unauthenticated" }
  | { state: "setup-required"; message: string }
  | { state: "error"; message: string };

class ConfigInvalid extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super("track configuration is invalid");
    this.errors = errors;
  }
}

class StageInUse extends Error {
  stageName: string;
  constructor(stageName: string) {
    super("stage is still referenced by history");
    this.stageName = stageName;
  }
}

function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || "stage";
}

export const saveTrackConfig = createServerFn({ method: "POST" })
  .validator(
    (input: {
      cadence?: unknown;
      deliveryMode?: unknown;
      stages?: unknown;
    }) => {
      const stagesRaw = Array.isArray(input?.stages) ? input.stages : [];
      const stages: SaveStageInput[] = stagesRaw.map((raw) => {
        const s = raw as Record<string, unknown>;
        const dwell = typeof s.expectedDwellDays === "number" && Number.isFinite(s.expectedDwellDays)
          ? Math.trunc(s.expectedDwellDays)
          : null;
        return {
          id: typeof s.id === "string" && s.id ? s.id : null,
          name: typeof s.name === "string" ? s.name.trim().slice(0, 200) : "",
          description: typeof s.description === "string" ? s.description.trim().slice(0, 2000) : "",
          expectedDwellDays: dwell !== null && dwell > 0 ? dwell : null,
          isTerminal: s.isTerminal === true,
          checkpointKind:
            typeof s.checkpointKind === "string" &&
            (CHECKPOINT_KINDS as readonly string[]).includes(s.checkpointKind)
              ? (s.checkpointKind as CheckpointKind)
              : null,
        };
      });
      return {
        cadence: typeof input?.cadence === "string" ? input.cadence : "",
        deliveryMode: typeof input?.deliveryMode === "string" ? input.deliveryMode : "",
        stages,
      };
    },
  )
  .handler(async ({ data }): Promise<SaveTrackConfigResult> => {
    const [{ getCookie }, { requireStaff }, { withTransaction }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("./auth-core"),
      import("../lib/pg"),
    ]);

    const auth = await requireStaff(getCookie(SESSION_COOKIE));
    if (!auth.ok) {
      if (auth.state === "db-unavailable") {
        return { state: "setup-required", message: auth.message ?? "The database is not reachable." };
      }
      return { state: "unauthenticated" };
    }
    if (auth.session.role !== "owner") {
      return { state: "forbidden" };
    }

    if (!(CADENCE_VALUES as readonly string[]).includes(data.cadence)) {
      return { state: "error", message: "Pick a valid cadence." };
    }
    if (!(DELIVERY_MODES as readonly string[]).includes(data.deliveryMode)) {
      return { state: "error", message: "Pick a valid delivery mode." };
    }
    if (data.stages.length < 2) {
      return { state: "error", message: "A track needs at least two stages." };
    }
    if (data.stages.some((s) => !s.name)) {
      return { state: "error", message: "Every stage needs a name." };
    }

    const churchId = auth.session.churchId;

    try {
      await withTransaction(async (client) => {
        const [config] = (
          await client.query<{ id: string }>(
            `select id from growth_track_configs where church_id = $1 and is_active`,
            [churchId],
          )
        ).rows;
        if (!config) throw new Error("no active track configuration");

        const existing = (
          await client.query<{ id: string; key: string }>(
            `select id, key from growth_track_stages where config_id = $1`,
            [config.id],
          )
        ).rows;
        const existingIds = new Set(existing.map((r) => r.id));
        const existingKeys = new Set(existing.map((r) => r.key));

        // Clear the (config_id, sequence) unique constraint's window before
        // reassigning final sequence numbers below — otherwise reordering two
        // stages can collide mid-update even though the end state is valid.
        await client.query(
          `update growth_track_stages set sequence = sequence + 100000 where config_id = $1`,
          [config.id],
        );

        const keptIds = new Set<string>();
        for (let i = 0; i < data.stages.length; i++) {
          const stage = data.stages[i];
          const sequence = i + 1;
          if (stage.id && existingIds.has(stage.id)) {
            keptIds.add(stage.id);
            await client.query(
              `update growth_track_stages
                  set name = $1, description = $2, sequence = $3, expected_dwell_days = $4,
                      is_terminal = $5, checkpoint_kind = $6, updated_at = now()
                where id = $7 and config_id = $8`,
              [
                stage.name,
                stage.description || null,
                sequence,
                stage.expectedDwellDays,
                stage.isTerminal,
                stage.checkpointKind,
                stage.id,
                config.id,
              ],
            );
          } else {
            let key = slugify(stage.name);
            let suffix = 2;
            while (existingKeys.has(key)) {
              key = `${slugify(stage.name)}_${String(suffix)}`;
              suffix += 1;
            }
            existingKeys.add(key);
            await client.query(
              `insert into growth_track_stages
                 (church_id, config_id, key, name, description, sequence, expected_dwell_days,
                  is_terminal, checkpoint_kind)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                churchId,
                config.id,
                key,
                stage.name,
                stage.description || null,
                sequence,
                stage.expectedDwellDays,
                stage.isTerminal,
                stage.checkpointKind,
              ],
            );
          }
        }

        const removedIds = existing.filter((r) => !keptIds.has(r.id)).map((r) => r.id);
        for (const removedId of removedIds) {
          try {
            await client.query(`delete from growth_track_stages where id = $1 and config_id = $2`, [
              removedId,
              config.id,
            ]);
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (code === "23503") {
              const removedStage = existing.find((r) => r.id === removedId);
              throw new StageInUse(removedStage?.key ?? removedId);
            }
            throw err;
          }
        }

        await client.query(
          `update growth_track_configs set cadence = $1, delivery_mode = $2, updated_at = now() where id = $3`,
          [data.cadence, data.deliveryMode, config.id],
        );

        const [validation] = (
          await client.query<{ is_valid: boolean; errors: string[] }>(
            `select is_valid, errors from validate_growth_track_config($1)`,
            [config.id],
          )
        ).rows;
        if (!validation?.is_valid) {
          throw new ConfigInvalid(validation?.errors ?? ["configuration is invalid"]);
        }

        await client.query(`update growth_track_configs set validated_at = now() where id = $1`, [config.id]);
      });

      return { state: "ok", message: "Track configuration saved." };
    } catch (err) {
      if (err instanceof ConfigInvalid) {
        return { state: "invalid", errors: err.errors };
      }
      if (err instanceof StageInUse) {
        return {
          state: "error",
          message: `Can't remove "${err.stageName}" — people have already passed through it. Rename or repurpose it instead of deleting it.`,
        };
      }
      console.error("saveTrackConfig failed", err);
      return { state: "error", message: "That configuration did not save." };
    }
  });
