-- Growth Track by Form — track-config editable fields (migration 0004)
--
-- HANDOFF item 4 (docs/handoff/04-self-serve-track-configuration.md): a church
-- configures cadence and delivery mode as part of "Your Own Growth Track" per
-- the architecture doc's Framework section. growth_track_configs (0001) never
-- got these two columns when the spine was built — this adds them.
--
-- Note for whoever merges this alongside the other open PRs: this repo
-- currently has more than one unmerged "0004" migration on different
-- branches (this one, 0004_automation_events.sql, and
-- 0004_stage_clock_tz_and_isolation.sql). None of their contents depend on
-- each other or conflict — each adds independent tables/columns/triggers —
-- so they can merge in any order and apply in whatever alphabetical order
-- the runner sorts them in. Worth a renumbering pass for cleanliness once
-- all three have landed, but nothing here requires it to be applied
-- correctly.
--
-- Idempotency: the runner wraps each file in a transaction and records it in
-- schema_migrations. Never edit an applied migration — add a new one.

alter table growth_track_configs
  add column cadence text not null default 'monthly'
    check (cadence in ('weekly', 'monthly', 'fast_track')),
  add column delivery_mode text not null default 'sequential'
    check (delivery_mode in ('sequential', 'flexible'));

comment on column growth_track_configs.cadence is
  'How often a step opens: weekly, monthly, or a single-afternoon fast_track — '
  'the architecture doc''s three observed patterns (Highlands/Faith Chapel/Union),'
  ' not an exhaustive enum. Purely descriptive today; nothing enforces cadence '
  'timing yet.';

comment on column growth_track_configs.delivery_mode is
  'sequential: steps must be taken in order (the default and the safer '
  'choice). flexible: a church allows non-sequential entry, per Union '
  'Church''s example in the architecture doc. Descriptive today — the app '
  'does not yet gate stage moves on this value.';
