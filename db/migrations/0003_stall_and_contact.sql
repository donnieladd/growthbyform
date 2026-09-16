-- Growth Track by Form — contact log + stall detection (migration 0003)
--
-- Slice 2 is the differentiator: the pipeline board, automatic stall detection and
-- the coach task list that builds itself. Everything that makes those possible is
-- here, and two rules are deliberately encoded in the database rather than in UI
-- code that could forget them:
--
--   1. "Who has stalled?" is a QUERY, not a report somebody has to remember to run.
--      person_stage_clock is the single definition of days-in-stage and days-overdue,
--      derived at read time from persons.stage_changed_at and the stage's
--      expected_dwell_days. There is no cron job, no scheduler and no background
--      process anywhere in this product: overdue is a function of now().
--
--   2. Logging a contact NEVER moves anybody. person_interactions is a log of what
--      staff did; the pipeline position lives in persons.current_stage_id and moves
--      only through set_person_stage(). Nothing in this file links the two, so a
--      coach recording a call cannot silently re-rank somebody in the pipeline.
--
-- Idempotency: the runner wraps each file in a transaction and records it in
-- schema_migrations. Never edit an applied migration — add a new one.

-- ---------------------------------------------------------------------------
-- The contact log: what the church actually did for this person
-- ---------------------------------------------------------------------------

create table person_interactions (
  id            uuid primary key default gen_random_uuid(),
  church_id     uuid not null references churches(id) on delete cascade,
  person_id     uuid not null references persons(id) on delete cascade,
  -- NULL = recorded by the system (a future automation), not by a staff member.
  staff_user_id uuid references staff_users(id) on delete set null,
  kind          text not null check (kind in ('call', 'text', 'email', 'in_person', 'note')),
  occurred_at   timestamptz not null default now(),
  body          text,
  created_at    timestamptz not null default now()
);

-- "What has this person heard from us?" — the person page reads it newest first.
create index person_interactions_person_idx
  on person_interactions (person_id, occurred_at desc);
-- "What did the church do this week?" — a church-wide view of the log.
create index person_interactions_church_idx
  on person_interactions (church_id, occurred_at desc);
-- "How much contact is this coach carrying?" — per staff member.
create index person_interactions_staff_idx
  on person_interactions (church_id, staff_user_id, occurred_at desc)
  where staff_user_id is not null;

create trigger person_interactions_same_church_person
  before insert or update on person_interactions for each row
  execute function enforce_same_church('person_id', 'persons');
create trigger person_interactions_same_church_staff
  before insert or update on person_interactions for each row
  execute function enforce_same_church('staff_user_id', 'staff_users');

-- ---------------------------------------------------------------------------
-- Who owns this person: a coach's task list is "mine" vs "everyone", never a
-- separate list somebody keeps in their head.
-- ---------------------------------------------------------------------------

alter table persons
  add column assigned_coach_user_id uuid references staff_users(id) on delete set null;

create index persons_church_coach_idx
  on persons (church_id, assigned_coach_user_id)
  where assigned_coach_user_id is not null;

create trigger persons_same_church_coach
  before insert or update on persons for each row
  execute function enforce_same_church('assigned_coach_user_id', 'staff_users');

-- ---------------------------------------------------------------------------
-- "Last contact" is derived, kept cheap, and never a column somebody sets by hand.
-- It is the most recent of: a logged interaction, a visit, a decision, and a
-- connect-card submission (the same definition slice 1's people list used, with
-- interactions added). person_interactions stays the source of truth; this column
-- exists only so a board of 2,000 people does not have to aggregate four tables
-- per card.
-- ---------------------------------------------------------------------------

alter table persons add column last_contact_at timestamptz;

create or replace function sync_person_last_contact() returns trigger
language plpgsql as $$
declare
  target uuid := coalesce(new.person_id, old.person_id);
begin
  if target is null then
    return null;
  end if;
  update persons p set last_contact_at = greatest(
    (select max(i.occurred_at) from person_interactions i where i.person_id = target),
    (select max(v.attended_at) from person_visits v where v.person_id = target),
    (select max(d.occurred_at) from decision_events d where d.person_id = target),
    (select max(s.submitted_at) from connect_card_submissions s where s.person_id = target)
  )
  where p.id = target;
  return null;
end $$;

create trigger person_interactions_sync_last_contact
  after insert or update or delete on person_interactions
  for each row execute function sync_person_last_contact();
create trigger person_visits_sync_last_contact
  after insert or update or delete on person_visits
  for each row execute function sync_person_last_contact();
create trigger decision_events_sync_last_contact
  after insert or update or delete on decision_events
  for each row execute function sync_person_last_contact();
create trigger connect_card_submissions_sync_last_contact
  after insert or update or delete on connect_card_submissions
  for each row execute function sync_person_last_contact();

-- Backfill for rows that predate this migration.
update persons p set last_contact_at = greatest(
  (select max(v.attended_at) from person_visits v where v.person_id = p.id),
  (select max(d.occurred_at) from decision_events d where d.person_id = p.id),
  (select max(s.submitted_at) from connect_card_submissions s where s.person_id = p.id)
);

-- ---------------------------------------------------------------------------
-- Stall detection as one definition: how long has this person been in their
-- current stage, and how far past that stage's expectation are they?
--
-- days_in_stage counts whole calendar days since the stage entry was stamped
-- (persons.stage_changed_at, written by record_stage_change() in 0002). A person
-- is OVERDUE when days_in_stage > expected_dwell_days, i.e. days_overdue > 0.
-- days_overdue is NULL where the stage sets no expectation (a terminal stage such
-- as Leading — nobody is ever overdue at the end of the track).
--
-- Callers read this view and filter; nothing stores the answer, so nothing goes
-- stale and no job has to re-run.
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
  (now()::date - p.stage_changed_at::date)::int as days_in_stage,
  case
    when s.expected_dwell_days is null then null
    else (now()::date - p.stage_changed_at::date)::int - s.expected_dwell_days
  end                                     as days_overdue
from persons p
join growth_track_stages s on s.id = p.current_stage_id
where p.stage_changed_at is not null;

-- The board reads every card with its clock, and the task list sorts by overdue —
-- both start from a person and their stage, which the spine already indexes.
create index persons_church_stage_entry_idx
  on persons (church_id, current_stage_id, stage_changed_at)
  where current_stage_id is not null;

-- ---------------------------------------------------------------------------
-- Fix: the stage-change trigger was dropping the actor and the timestamp.
--
-- record_stage_change() (0002) decided whether to use the caller's actor and time
-- with `current_setting(...) not in ('', null)`. In SQL that expression is NULL —
-- not TRUE — for any real value, because `x IN ('', NULL)` is `false OR NULL`. So
-- the branch was never taken and EVERY stage move was recorded with a NULL actor
-- and changed_at = now(), including the seed's backdated placements. Stall
-- detection runs off persons.stage_changed_at, so this had to be fixed before the
-- board could be trusted: a person's dwell clock would have restarted from "now"
-- on every backfilled placement, and the timeline would not say who moved them.
--
-- 0002 is already applied and must not be edited, so the corrected function is
-- installed here, with the same name and the same contract. Callers are unchanged:
-- set the growthtrack.actor_id / reason / source / at session settings, then write
-- persons.current_stage_id.
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

  -- nullif() turns an unset/blank setting into NULL, and IS NOT NULL is a real
  -- boolean test — unlike `not in ('', null)`, which is NULL for every value.
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

  -- The dwell clock. Setting only this column does not re-fire this trigger (it is
  -- scoped to current_stage_id), so there is no recursion.
  update persons set stage_changed_at = v_at where id = new.id;

  perform set_config('growthtrack.actor_id', '', true);
  perform set_config('growthtrack.reason', '', true);
  perform set_config('growthtrack.at', '', true);
  perform set_config('growthtrack.source', '', true);
  return null;
end $$;

comment on view person_stage_clock is
  'Stall detection: days in the current stage and how far past that stage''s expected dwell somebody is. Derived at read time — nothing stores "overdue".';
