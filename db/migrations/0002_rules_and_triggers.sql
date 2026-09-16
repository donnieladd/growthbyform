-- Growth Track by Form — rules, triggers, integrity (migration 0002)
--
-- Everything here exists so that a rule the product depends on cannot be broken
-- by a code path that forgot about it: tenant consistency, visit rollups, the
-- stage timeline, and the checkpoint rules for a Growth Track config.

-- ---------------------------------------------------------------------------
-- updated_at bookkeeping
-- ---------------------------------------------------------------------------

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger churches_touch_updated_at
  before update on churches for each row execute function touch_updated_at();
create trigger staff_users_touch_updated_at
  before update on staff_users for each row execute function touch_updated_at();
create trigger households_touch_updated_at
  before update on households for each row execute function touch_updated_at();
create trigger persons_touch_updated_at
  before update on persons for each row execute function touch_updated_at();
create trigger growth_track_configs_touch_updated_at
  before update on growth_track_configs for each row execute function touch_updated_at();
create trigger growth_track_stages_touch_updated_at
  before update on growth_track_stages for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Tenant consistency: a child row can never point at a parent in another church.
-- TG_ARGV[0] = FK column on this row, TG_ARGV[1] = referenced table.
-- ---------------------------------------------------------------------------

create or replace function enforce_same_church() returns trigger
language plpgsql as $$
declare
  ref_id     uuid;
  ref_church uuid;
  ref_table  text := tg_argv[1];
begin
  ref_id := (to_jsonb(new) ->> tg_argv[0])::uuid;
  if ref_id is null then
    return new;
  end if;
  execute format('select church_id from %I where id = $1', ref_table)
    into ref_church using ref_id;
  if ref_church is null or ref_church = new.church_id then
    return new;
  end if;
  raise exception '% .% points at a row in another church (row church %, target church %)',
    tg_table_name, tg_argv[0], new.church_id, ref_church
    using errcode = 'foreign_key_violation';
end $$;

-- staff_users is deliberately NOT guarded by enforce_same_church: its church_id IS
-- the foreign key to the tenant, so there is nothing above it to disagree with.
create trigger staff_sessions_same_church
  before insert or update on staff_sessions for each row
  execute function enforce_same_church('staff_user_id', 'staff_users');
create trigger growth_track_stages_same_church
  before insert or update on growth_track_stages for each row
  execute function enforce_same_church('config_id', 'growth_track_configs');
create trigger persons_same_church_household
  before insert or update on persons for each row
  execute function enforce_same_church('household_id', 'households');
create trigger persons_same_church_stage
  before insert or update on persons for each row
  execute function enforce_same_church('current_stage_id', 'growth_track_stages');
create trigger person_visits_same_church
  before insert or update on person_visits for each row
  execute function enforce_same_church('person_id', 'persons');
create trigger connect_card_submissions_same_church
  before insert or update on connect_card_submissions for each row
  execute function enforce_same_church('person_id', 'persons');
create trigger step_completions_same_church
  before insert or update on step_completions for each row
  execute function enforce_same_church('person_id', 'persons');
create trigger decision_events_same_church
  before insert or update on decision_events for each row
  execute function enforce_same_church('person_id', 'persons');
create trigger stage_history_same_church
  before insert or update on stage_history for each row
  execute function enforce_same_church('person_id', 'persons');

-- ---------------------------------------------------------------------------
-- person_visits is the source of truth for visit facts; persons carries a cheap
-- rollup so lists and stall queries do not have to aggregate every time.
-- ---------------------------------------------------------------------------

create or replace function sync_person_visit_rollup() returns trigger
language plpgsql as $$
declare
  target uuid := coalesce(new.person_id, old.person_id);
begin
  update persons p set
    visit_count    = coalesce(v.cnt, 0),
    first_visit_at = v.first_at,
    last_visit_at  = v.last_at
  from (
    select count(*)::int as cnt, min(attended_at) as first_at, max(attended_at) as last_at
    from person_visits where person_id = target
  ) v
  where p.id = target;
  return null;
end $$;

create trigger person_visits_sync_rollup
  after insert or update or delete on person_visits
  for each row execute function sync_person_visit_rollup();

-- ---------------------------------------------------------------------------
-- The timeline is reconstructable: every stage change writes a stage_history row,
-- including the stage somebody starts in. Callers set the actor/reason through
-- session settings so the history is written where the change actually happens.
-- ---------------------------------------------------------------------------

-- set_person_stage() is the one blessed way to move somebody. It stamps who did
-- it and why, and lets a caller (seed, import) place the event in the past.
create or replace function set_person_stage(
  p_person_id uuid,
  p_stage_id  uuid,
  p_staff_id  uuid default null,
  p_reason    text default null,
  p_source    text default 'staff_entry',
  p_at        timestamptz default null
) returns void
language plpgsql as $$
declare
  v_person_church uuid;
  v_stage_church  uuid;
  v_at            timestamptz := coalesce(p_at, now());
begin
  select church_id into v_person_church from persons where id = p_person_id;
  if v_person_church is null then
    raise exception 'person % not found', p_person_id;
  end if;
  select church_id into v_stage_church from growth_track_stages where id = p_stage_id;
  if v_stage_church is null then
    raise exception 'stage % not found', p_stage_id;
  end if;
  if v_stage_church <> v_person_church then
    raise exception 'stage % belongs to another church', p_stage_id;
  end if;

  perform set_config('growthtrack.actor_id', coalesce(p_staff_id::text, ''), true);
  perform set_config('growthtrack.reason', coalesce(p_reason, ''), true);
  perform set_config('growthtrack.source', p_source, true);
  perform set_config('growthtrack.at', v_at::text, true);

  update persons set current_stage_id = p_stage_id where id = p_person_id;
end $$;

create or replace function record_stage_change() returns trigger
language plpgsql as $$
declare
  v_actor  uuid;
  v_at     timestamptz := now();
  v_source text;
  v_from   uuid;
begin
  if new.current_stage_id is null then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    if new.current_stage_id is not distinct from old.current_stage_id then
      return null;
    end if;
    v_from := old.current_stage_id;
  end if;

  if current_setting('growthtrack.actor_id', true) not in ('', null) then
    v_actor := current_setting('growthtrack.actor_id')::uuid;
  end if;
  if current_setting('growthtrack.at', true) not in ('', null) then
    v_at := current_setting('growthtrack.at')::timestamptz;
  end if;
  v_source := coalesce(nullif(current_setting('growthtrack.source', true), ''), 'system');

  -- AFTER trigger on purpose: the person row exists by now, so stage_history's
  -- foreign key to persons holds. (A BEFORE trigger cannot insert a child row that
  -- points at a parent that has not been written yet.)
  insert into stage_history (
    church_id, person_id, from_stage_id, to_stage_id, changed_at,
    changed_by_staff_id, reason, source
  ) values (
    new.church_id,
    new.id,
    v_from,
    new.current_stage_id,
    v_at,
    v_actor,
    nullif(current_setting('growthtrack.reason', true), ''),
    v_source
  );

  -- stage_changed_at is what stall detection will read, so keep it exact. Setting
  -- only this column does not re-fire this trigger (it is scoped to current_stage_id).
  update persons set stage_changed_at = v_at where id = new.id;

  -- Clear the one-shot session settings so a later, unrelated update in the same
  -- transaction cannot inherit this actor.
  perform set_config('growthtrack.actor_id', '', true);
  perform set_config('growthtrack.reason', '', true);
  perform set_config('growthtrack.at', '', true);
  perform set_config('growthtrack.source', '', true);
  return null;
end $$;

create trigger persons_record_stage_change
  after insert or update of current_stage_id on persons
  for each row execute function record_stage_change();

-- ---------------------------------------------------------------------------
-- Checkpoint rules. The (later) config validator UI is out of scope for this
-- slice, but the rule has to be expressible and checkable now, so it lives here
-- as a function the app, the seed and CI can all call.
--
--   Belonging            required, first
--   Self-understanding   required, before deployment
--   Leadership/Character optional, anywhere
--   Deployment           required, last
-- ---------------------------------------------------------------------------

create or replace function validate_growth_track_config(p_config_id uuid)
returns table (is_valid boolean, errors text[])
language plpgsql stable as $$
declare
  v_cfg        growth_track_configs%rowtype;
  v_count      int;
  v_belonging  int;
  v_self       int;
  v_deploy     int;
  v_min_seq    int;
  v_belong_seq int;
  v_self_seq   int;
  v_deploy_seq int;
  v_max_seq    int;
  v_errs       text[] := '{}';
begin
  select * into v_cfg from growth_track_configs where id = p_config_id;
  if v_cfg.id is null then
    return query select false, array['config not found'];
    return;
  end if;

  select count(*)::int, min(sequence), max(sequence) into v_count, v_min_seq, v_max_seq
    from growth_track_stages where config_id = p_config_id;

  if v_count < 2 then
    v_errs := array_append(v_errs, 'a track needs at least two stages');
  end if;

  select count(*)::int, min(sequence) into v_belonging, v_belong_seq
    from growth_track_stages where config_id = p_config_id and checkpoint_kind = 'belonging';
  select count(*)::int, min(sequence) into v_self, v_self_seq
    from growth_track_stages where config_id = p_config_id and checkpoint_kind = 'self_understanding';
  select count(*)::int, min(sequence) into v_deploy, v_deploy_seq
    from growth_track_stages where config_id = p_config_id and checkpoint_kind = 'deployment';

  if v_cfg.requires_belonging then
    if v_belonging = 0 then
      v_errs := array_append(v_errs, 'belonging checkpoint is required but no stage carries it');
    elsif v_belonging > 1 then
      v_errs := array_append(v_errs, 'belonging is a single checkpoint but more than one stage carries it');
    elsif v_belong_seq <> v_min_seq then
      v_errs := array_append(v_errs, 'belonging must be the first checkpoint in the track');
    end if;
  end if;

  if v_cfg.requires_self_understanding then
    if v_self = 0 then
      v_errs := array_append(v_errs, 'self-understanding checkpoint is required but no stage carries it');
    elsif v_self > 1 then
      v_errs := array_append(v_errs, 'self-understanding is a single checkpoint but more than one stage carries it');
    end if;
  end if;

  if v_cfg.requires_deployment then
    if v_deploy = 0 then
      v_errs := array_append(v_errs, 'deployment checkpoint is required but no stage carries it');
    elsif v_deploy > 1 then
      v_errs := array_append(v_errs, 'deployment is a single checkpoint but more than one stage carries it');
    elsif v_deploy_seq <> v_max_seq then
      v_errs := array_append(v_errs, 'deployment must be the last stage in the track');
    end if;
  end if;

  if v_cfg.requires_self_understanding and v_cfg.requires_deployment
     and v_self > 0 and v_deploy > 0 and v_self_seq >= v_deploy_seq then
    v_errs := array_append(v_errs, 'self-understanding must come before deployment');
  end if;

  return query select (cardinality(v_errs) = 0), v_errs;
end $$;
