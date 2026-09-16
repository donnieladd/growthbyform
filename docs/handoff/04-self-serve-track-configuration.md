# Task 04 — Self-serve track configuration

**Backlog id:** `06f86091-54c1-4e81-9b49-0ebee59de364`
**Status:** Not started at the UI level. Database-level validation already exists.

## Goal

A recruited church can configure its own growth track — step count, names, cadence, delivery mode —
without us in the room, and the system refuses to publish a track that breaks the method.

## Why now

The owner is actively recruiting the pilot church (their task, not ours). The pilot's identity does
not gate the build, but a church that configures its own track is the difference between a demo and a
product. This slice was promoted in the business plan for exactly that reason.

## What already exists (do not rebuild)

- `validate_growth_track_config()` (migration `0002_rules_and_triggers.sql`) refuses, **in the
  database**, a track that: is missing a required checkpoint, does not start with Belonging, or
  sequences Deployment before Self-understanding. Community/small groups is a parallel destination,
  never a sequenced step or checkpoint.
- `growth_track_configs` and `growth_track_stages` tables; the board reads stages from the DB (never
  hard-coded), so a configured track flows through automatically.
- A checkpoint-rule self-test exists in `scripts/verify.ts` and still passes.

## What to build

1. A staff-facing track configuration screen (owner role — gate on `staff_users.role`).
2. Edit: step count, step names, expected dwell per stage, delivery mode, cadence.
3. Save path goes through the DB validation — the UI should surface the refusal reasons as readable
   messages, not raw SQL errors.
4. Changing stage names must not orphan data: `stage_history`, `persons.current_stage_id`,
   `step_completions` all FK into stages — decide whether config edits existing stages in place
   (preferred) or creates a new config version; document the choice.

## Definition of done

`bun run build` green; real-browser verification: configure a valid custom track and see the board
re-render with it; attempt an invalid track (deployment before self-understanding) and see the refusal
with a readable reason; existing people keep coherent history after a rename.
