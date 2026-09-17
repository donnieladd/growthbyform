-- Growth Track by Form — merge flagged duplicates (migration 0004)
--
-- persons.review_flag exists precisely so a possible duplicate "stays visible
-- and mergeable instead of rotting" (0001_spine.sql's own comment) — this is
-- the mergeable part. A merge re-points every piece of the loser's history
-- onto the survivor, then deletes the loser row. History is never dropped;
-- only the now-redundant person row is.
--
-- Every table with a not-null person_id FK into persons is `on delete
-- cascade` (person_visits, connect_card_submissions, step_completions,
-- decision_events, stage_history, person_interactions) — deleting a person
-- row without first re-pointing all of those would silently destroy their
-- history. The application code that performs a merge re-points every one of
-- them, in a single transaction, before the delete — this migration doesn't
-- change any of that cascade behavior; it only adds the audit trail.
--
-- Note for whoever merges this alongside the other open PRs: another
-- unmerged "0004" already exists on this repo (this one adds a table, the
-- others add columns/triggers to different tables) — see the note already
-- left in 0004_track_config_editable_fields.sql. Still no content conflict.
--
-- Idempotency: the runner wraps each file in a transaction and records it in
-- schema_migrations. Never edit an applied migration — add a new one.

create table person_merges (
  id                     uuid primary key default gen_random_uuid(),
  church_id              uuid not null references churches(id) on delete cascade,
  kept_person_id         uuid not null references persons(id) on delete cascade,
  -- The merged-away person no longer exists once this row is written — this
  -- is a snapshot, not a live FK, so the audit trail survives the deletion
  -- it's recording.
  merged_person_snapshot jsonb not null,
  reason                 text,
  merged_by_staff_id     uuid references staff_users(id),
  created_at             timestamptz not null default now()
);

create index person_merges_kept_person_idx on person_merges (kept_person_id, created_at desc);
create index person_merges_church_idx on person_merges (church_id, created_at desc);

comment on table person_merges is
  'Audit trail for resolved duplicates. The merged person''s row is gone (its '
  'history was re-pointed to kept_person_id, then the row itself deleted) — '
  'merged_person_snapshot is what remains of it: enough to know who it was '
  'and why it was merged, not a restorable backup.';
