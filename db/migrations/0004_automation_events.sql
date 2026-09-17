-- Growth Track by Form — automation outbox (migration 0004)
--
-- Foundation for Engine 5 (automation/trigger runtime) and Engine 9
-- (integrations) per docs/ARCHITECTURE.md's build sequence — neither exists
-- yet, so this is pure addition, no existing behavior changes.
--
-- The pattern: automation_events is a durable outbox, written in the SAME
-- transaction as the thing that happened (a trigger, not application code),
-- so an event can never be silently dropped even if nothing is listening —
-- if the consuming service is down, events just queue. A pg_notify() on
-- insert gives a low-latency wake-up to a listening consumer; the table
-- itself is the source of truth, not the notification (Postgres NOTIFY
-- payloads are fire-and-forget and are lost if nobody is listening at the
-- moment they fire — the row is what survives a restart).
--
-- Nothing here processes an event. A separate service (the Go automation
-- runtime, additive, not part of this app) polls/listens and marks rows
-- processed. This app never assumes that service is running: it only ever
-- writes here, never reads its own writes back.
--
-- Idempotency: the runner wraps each file in a transaction and records it in
-- schema_migrations. Never edit an applied migration — add a new one.

create table automation_events (
  id           uuid primary key default gen_random_uuid(),
  church_id    uuid not null references churches(id) on delete cascade,
  -- Nullable: not every event is about one person (a future church-level or
  -- group-level event still fits this same table).
  person_id    uuid references persons(id),
  event_type   text not null,
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  -- A consumer claims a row before working it, so two workers (or a restarted
  -- one) don't double-process the same event.
  claimed_at   timestamptz,
  claimed_by   text,
  processed_at timestamptz,
  attempts     int not null default 0,
  last_error   text
);

create trigger automation_events_same_church_person
  before insert or update on automation_events
  for each row
  execute function enforce_same_church('person_id', 'persons');

-- The consumer's main query: unclaimed (or stale-claimed) events, oldest first.
create index automation_events_pending_idx
  on automation_events (church_id, created_at)
  where processed_at is null;

create or replace function notify_automation_event() returns trigger
language plpgsql as $$
begin
  perform pg_notify('automation_events', new.id::text);
  return new;
end $$;

create trigger automation_events_notify
  after insert on automation_events
  for each row
  execute function notify_automation_event();

-- ---------------------------------------------------------------------------
-- Wire the first real event source: a stage change. record_stage_change()
-- (0002, corrected in 0003) already runs inside the one blessed path for
-- moving somebody (set_person_stage()); it is extended here — same name,
-- same contract, same precedent 0003 already set for fixing a function
-- without editing the file that first created it — to also drop an outbox
-- row for the new automation runtime to pick up.
-- ---------------------------------------------------------------------------
create or replace function record_stage_change() returns trigger
language plpgsql as $$
declare
  v_actor      uuid;
  v_at         timestamptz := now();
  v_source     text;
  v_from       uuid;
  v_actor_text text;
  v_at_text    text;
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

  v_actor_text := nullif(current_setting('growthtrack.actor_id', true), '');
  v_at_text    := nullif(current_setting('growthtrack.at', true), '');
  if v_actor_text is not null then
    v_actor := v_actor_text::uuid;
  end if;
  if v_at_text is not null then
    v_at := v_at_text::timestamptz;
  end if;
  v_source := coalesce(nullif(current_setting('growthtrack.source', true), ''), 'system');

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

  update persons set stage_changed_at = v_at where id = new.id;

  insert into automation_events (church_id, person_id, event_type, payload)
  values (
    new.church_id,
    new.id,
    'stage_changed',
    jsonb_build_object(
      'from_stage_id', v_from,
      'to_stage_id', new.current_stage_id,
      'changed_at', v_at,
      'source', v_source
    )
  );

  perform set_config('growthtrack.actor_id', '', true);
  perform set_config('growthtrack.reason', '', true);
  perform set_config('growthtrack.at', '', true);
  perform set_config('growthtrack.source', '', true);
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Second event source: a connect-card submission (capture). Distinguishes
-- first-time from returning per the PRD's own trigger table — a returning
-- guest is the stronger, more time-sensitive signal (Engine 1's stated
-- "second visit is the strongest predictor of assimilation").
-- ---------------------------------------------------------------------------
create or replace function notify_connect_card_submission() returns trigger
language plpgsql as $$
begin
  insert into automation_events (church_id, person_id, event_type, payload)
  values (
    new.church_id,
    new.person_id,
    case when new.visit_report = 'returning' then 'second_visit_recorded' else 'first_time_guest_recorded' end,
    jsonb_build_object('submission_id', new.id, 'visit_id', new.visit_id, 'matched_on', new.matched_on)
  );
  return new;
end $$;

create trigger connect_card_submissions_automation_event
  after insert on connect_card_submissions
  for each row
  execute function notify_connect_card_submission();
