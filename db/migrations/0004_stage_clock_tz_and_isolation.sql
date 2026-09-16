-- Growth Track by Form — stage-clock timezone + stage-reference tenant isolation
-- (migration 0004)
--
-- Two independent fixes, bundled because both are cheap schema-only changes with
-- no data migration:
--
--   1. person_stage_clock (0003) computed days_in_stage / days_overdue using
--      now()::date and stage_changed_at::date in the DB session's default
--      timezone. churches.timezone (0001) was stored but never read anywhere —
--      a church outside the session's zone could flip "overdue" up to a day
--      early or late around midnight. Fixed by converting both sides to the
--      owning church's timezone before taking the date.
--
--   2. enforce_same_church (0002) was wired onto step_completions.person_id,
--      decision_events.person_id and stage_history.person_id, but never onto
--      their stage references (step_completions.stage_id,
--      decision_events.stage_id_at_event, stage_history.from_stage_id /
--      to_stage_id). Nothing at the database level stopped a row from citing
--      another church's stage through those columns. Dormant today (only the
--      seed script writes these tables), but the decision-events UI is the
--      next slice built on this schema — closing the gap now, before a write
--      path exists that could hit it.
--
-- Idempotency: the runner wraps each file in a transaction and records it in
-- schema_migrations. Never edit an applied migration — add a new one.

-- ---------------------------------------------------------------------------
-- Fix 1: person_stage_clock in the church's own timezone.
-- ---------------------------------------------------------------------------
create or replace view person_stage_clock as
select
  p.id                                    as person_id,
  p.church_id                             as church_id,
  p.current_stage_id                      as stage_id,
  s.name                                  as stage_name,
  s.sequence                              as stage_sequence,
  s.key                                   as stage_key,
  s.is_terminal                           as is_terminal,
  s.expected_dwell_days                   as expected_dwell_days,
  p.stage_changed_at                      as stage_entered_at,
  ((now() at time zone c.timezone)::date
    - (p.stage_changed_at at time zone c.timezone)::date)::int as days_in_stage,
  case
    when s.expected_dwell_days is null then null
    else ((now() at time zone c.timezone)::date
      - (p.stage_changed_at at time zone c.timezone)::date)::int - s.expected_dwell_days
  end                                     as days_overdue
from persons p
join churches c on c.id = p.church_id
join growth_track_stages s on s.id = p.current_stage_id
where p.stage_changed_at is not null;

comment on view person_stage_clock is
  'Stall detection, computed in the owning church''s own timezone (churches.timezone), '
  'not the DB session default. Still derived at read time — nothing stored, nothing to '
  're-run.';

-- ---------------------------------------------------------------------------
-- Fix 2: tenant isolation on every stage reference, not just person_id.
-- ---------------------------------------------------------------------------
create trigger step_completions_same_church_stage
  before insert or update on step_completions
  for each row
  execute function enforce_same_church('stage_id', 'growth_track_stages');

create trigger decision_events_same_church_stage
  before insert or update on decision_events
  for each row
  execute function enforce_same_church('stage_id_at_event', 'growth_track_stages');

create trigger stage_history_same_church_from_stage
  before insert or update on stage_history
  for each row
  execute function enforce_same_church('from_stage_id', 'growth_track_stages');

create trigger stage_history_same_church_to_stage
  before insert or update on stage_history
  for each row
  execute function enforce_same_church('to_stage_id', 'growth_track_stages');
