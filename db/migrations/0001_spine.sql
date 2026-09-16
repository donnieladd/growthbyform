-- Growth Track by Form — MVP spine (migration 0001)
--
-- One Person record and one continuous stage timeline that every part of the
-- church reads from and writes to. This file is the physical shape of that idea.
--
-- Multi-tenant from day one: every tenant-scoped table carries church_id, so the
-- schema can move to Supabase (or any Postgres) with row-level security later
-- without a rewrite. Nothing here assumes Neon, Supabase or any single provider.
--
-- Modeling rules encoded below (decided in the planning pass — do not re-litigate):
--   * decision_events are REPEATABLE, TIMESTAMPED FACTS in their own table. There
--     is deliberately no unique constraint on (person_id, event_type) and no
--     stage coupling: a decision never moves somebody in the pipeline. The
--     stage_id_at_event column is CONTEXT (where they happened to be at the
--     time), not a relationship the pipeline is allowed to read as state.
--   * person_visits holds one row per visit with a real visit_number. Visit 1 and
--     visit 2 are distinct, differently-urgent facts: the second visit is the
--     strongest predictor of whether somebody assimilates.
--   * growth_track_stages carries expected_dwell_days, so "who has stalled?" is a
--     query rather than a report somebody has to remember to look at.
--   * Community / small groups is a PARALLEL destination the track feeds into,
--     never a sequenced step and never a required checkpoint. The "Connected"
--     stage below is relational connection ("knows and is known"), not a gate.
--   * Checkpoint rules: Belonging (required, first), Self-understanding (required,
--     before deployment), Leadership/Character (optional), Deployment (required,
--     last). Stages carry checkpoint_kind and validate_growth_track_config()
--     (see 0002) refuses a track that breaks the rules.
--
-- Idempotency: the runner wraps each file in a transaction and records it in
-- schema_migrations. Never edit an applied migration — add a new one.

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------

create table churches (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  timezone    text not null default 'America/New_York',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Staff identity (built in-house: email + scrypt password hash + opaque session)
-- ---------------------------------------------------------------------------

create table staff_users (
  id               uuid primary key default gen_random_uuid(),
  church_id        uuid not null references churches(id) on delete cascade,
  email            text not null,
  email_lower      text not null,
  name             text not null,
  role             text not null default 'staff' check (role in ('owner', 'staff', 'coach')),
  -- scrypt hash, self-describing: scrypt$N$r$p$salt$key (see src/lib/auth.ts)
  password_hash    text not null,
  password_set_at  timestamptz,
  is_active        boolean not null default true,
  last_sign_in_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (church_id, email_lower)
);

create index staff_users_email_lower_idx on staff_users (email_lower);

-- Sessions are server-side rows. The cookie only ever carries an opaque random
-- token; the table stores its SHA-256 so a database leak cannot be replayed.
create table staff_sessions (
  id            uuid primary key default gen_random_uuid(),
  church_id     uuid not null references churches(id) on delete cascade,
  staff_user_id uuid not null references staff_users(id) on delete cascade,
  token_hash    text not null unique,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  user_agent    text
);

create index staff_sessions_staff_user_idx on staff_sessions (staff_user_id);
create index staff_sessions_expires_idx on staff_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- The pipeline definition: one active Growth Track config per church
-- ---------------------------------------------------------------------------

create table growth_track_configs (
  id                          uuid primary key default gen_random_uuid(),
  church_id                   uuid not null references churches(id) on delete cascade,
  name                        text not null default 'Growth Track',
  is_active                   boolean not null default true,
  -- Checkpoint rules as data, so the (later) config validator can enforce them
  -- and a church can be honest about which ones it holds to.
  requires_belonging          boolean not null default true,
  requires_self_understanding boolean not null default true,
  allows_leadership_character boolean not null default true,
  requires_deployment         boolean not null default true,
  validated_at                timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create unique index growth_track_configs_one_active_idx
  on growth_track_configs (church_id) where is_active;

create table growth_track_stages (
  id                  uuid primary key default gen_random_uuid(),
  church_id           uuid not null references churches(id) on delete cascade,
  config_id           uuid not null references growth_track_configs(id) on delete cascade,
  key                 text not null,
  name                text not null,
  description         text,
  sequence            integer not null check (sequence >= 1),
  -- Stall detection input: how long somebody may sit in this stage before they
  -- should surface on a coach's task list. NULL = no expectation (terminal stage).
  expected_dwell_days integer check (expected_dwell_days is null or expected_dwell_days > 0),
  is_terminal         boolean not null default false,
  checkpoint_kind     text check (checkpoint_kind in
                        ('belonging', 'self_understanding', 'leadership_character', 'deployment')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (config_id, key),
  unique (config_id, sequence)
);

-- Belonging, self-understanding and deployment are singular checkpoints; only
-- leadership/character may appear more than once (it is the optional one).
create unique index growth_track_stages_singleton_checkpoint_idx
  on growth_track_stages (config_id, checkpoint_kind)
  where checkpoint_kind in ('belonging', 'self_understanding', 'deployment');

-- ---------------------------------------------------------------------------
-- Households and the one Person record
-- ---------------------------------------------------------------------------

create table households (
  id                 uuid primary key default gen_random_uuid(),
  church_id          uuid not null references churches(id) on delete cascade,
  name               text not null,
  address_line1      text,
  address_line2      text,
  city               text,
  region             text,
  postal_code        text,
  country            text not null default 'US',
  -- match key (normalized in src/lib/normalize.ts, same function used everywhere)
  address_normalized text,
  phone_e164         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index households_church_address_norm_idx
  on households (church_id, address_normalized) where address_normalized is not null;
create index households_church_phone_idx
  on households (church_id, phone_e164) where phone_e164 is not null;

create table persons (
  id                 uuid primary key default gen_random_uuid(),
  church_id          uuid not null references churches(id) on delete cascade,
  household_id       uuid references households(id) on delete set null,
  first_name         text not null,
  last_name          text not null,
  full_name          text generated always as (btrim(first_name || ' ' || last_name)) stored,
  email              text,
  email_lower        text,
  phone              text,
  -- Normalized match keys. Identity resolution is the whole point of capture:
  -- every intake channel has to land on the SAME row here, never a twin.
  phone_e164         text,
  name_normalized    text not null,
  address_normalized text,
  is_child           boolean not null default false,
  -- Set when capture could not be certain (e.g. a self-reported returning guest we
  -- have never seen, or a same-name person we refused to silently merge). This is
  -- how a possible duplicate stays visible and mergeable instead of rotting.
  review_flag        text,
  -- Pipeline position. Exactly one, always; the timeline lives in stage_history.
  current_stage_id   uuid references growth_track_stages(id),
  stage_changed_at   timestamptz,
  -- Visit rollup, maintained by trigger from person_visits (0002). person_visits is
  -- the source of truth; these columns exist so lists and stall queries are cheap.
  first_visit_at     timestamptz,
  last_visit_at      timestamptz,
  visit_count        integer not null default 0,
  created_via        text not null default 'connect_card'
                       check (created_via in ('connect_card', 'kiosk', 'staff_entry', 'import')),
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index persons_church_phone_e164_idx
  on persons (church_id, phone_e164) where phone_e164 is not null;
create index persons_church_email_lower_idx
  on persons (church_id, email_lower) where email_lower is not null;
create index persons_church_name_norm_idx
  on persons (church_id, name_normalized);
create index persons_church_name_addr_idx
  on persons (church_id, name_normalized, address_normalized)
  where address_normalized is not null;
create index persons_household_idx on persons (household_id);
create index persons_church_stage_idx on persons (church_id, current_stage_id);
-- Stall queries will ask "who is in stage X and has been since before <cutoff>".
create index persons_church_stage_changed_idx on persons (church_id, stage_changed_at);
create index persons_church_review_flag_idx
  on persons (church_id, review_flag) where review_flag is not null;

-- ---------------------------------------------------------------------------
-- Visits — the differently-urgent facts
-- ---------------------------------------------------------------------------

create table person_visits (
  id                   uuid primary key default gen_random_uuid(),
  church_id            uuid not null references churches(id) on delete cascade,
  person_id            uuid not null references persons(id) on delete cascade,
  visit_number         integer not null check (visit_number >= 1),
  attended_at          timestamptz not null default now(),
  source               text not null check (source in ('connect_card', 'kiosk', 'staff_entry')),
  note                 text,
  recorded_by_staff_id uuid references staff_users(id),
  created_at           timestamptz not null default now(),
  -- Two rows can never claim to be the same visit.
  unique (person_id, visit_number)
);

create index person_visits_person_idx on person_visits (person_id, visit_number);
create index person_visits_church_attended_idx on person_visits (church_id, attended_at desc);
-- "Who came back a second time?" is a first-class question, so it gets its own
-- index rather than being discovered by counting rows at read time.
create index person_visits_second_visit_idx
  on person_visits (church_id, attended_at desc) where visit_number = 2;

-- Raw intake record for the public connect card: what the guest actually told us,
-- kept verbatim next to the resolved person + visit it produced.
create table connect_card_submissions (
  id                     uuid primary key default gen_random_uuid(),
  church_id              uuid not null references churches(id) on delete cascade,
  person_id              uuid not null references persons(id) on delete cascade,
  visit_id               uuid references person_visits(id) on delete set null,
  submitted_at           timestamptz not null default now(),
  visit_report           text not null check (visit_report in ('first_time', 'returning', 'unsure')),
  -- Which key resolved this submission, or that we created a person instead.
  matched_on             text not null check (matched_on in
                           ('phone_e164', 'email_lower', 'name_and_address', 'household', 'no_match_created')),
  matched_person_id      uuid references persons(id),
  children_text          text,
  household_members_text text,
  how_heard              text,
  prayer_request         text,
  raw                    jsonb not null default '{}'::jsonb
);

create index connect_card_submissions_person_idx on connect_card_submissions (person_id, submitted_at desc);
create index connect_card_submissions_church_idx on connect_card_submissions (church_id, submitted_at desc);

-- ---------------------------------------------------------------------------
-- Step completions (Growth Track sessions, classes, milestones)
-- ---------------------------------------------------------------------------

create table step_completions (
  id                   uuid primary key default gen_random_uuid(),
  church_id            uuid not null references churches(id) on delete cascade,
  person_id            uuid not null references persons(id) on delete cascade,
  stage_id             uuid references growth_track_stages(id),
  step_key             text not null,
  step_name            text,
  completed_at         timestamptz not null default now(),
  source               text not null default 'staff_entry'
                         check (source in ('staff_entry', 'connect_card', 'kiosk', 'import')),
  completed_by_staff_id uuid references staff_users(id),
  notes                text,
  created_at           timestamptz not null default now(),
  unique (person_id, step_key)
);

create index step_completions_person_idx on step_completions (person_id, completed_at desc);
create index step_completions_church_stage_idx on step_completions (church_id, stage_id);

-- ---------------------------------------------------------------------------
-- Decision events — repeatable, timestamped, structurally separate from stage
-- ---------------------------------------------------------------------------

create table decision_events (
  id                   uuid primary key default gen_random_uuid(),
  church_id            uuid not null references churches(id) on delete cascade,
  person_id            uuid not null references persons(id) on delete cascade,
  event_type           text not null check (event_type in ('salvation', 'rededication', 'baptism')),
  occurred_at          timestamptz not null default now(),
  recorded_at          timestamptz not null default now(),
  -- CONTEXT ONLY. Where the person stood when this happened; it never moves them
  -- and the pipeline never treats it as state.
  stage_id_at_event    uuid references growth_track_stages(id),
  source               text not null default 'staff_entry'
                         check (source in ('staff_entry', 'connect_card', 'kiosk', 'import')),
  notes                text,
  recorded_by_staff_id uuid references staff_users(id),
  created_at           timestamptz not null default now()
);

create index decision_events_person_idx on decision_events (person_id, occurred_at desc);
create index decision_events_church_type_idx on decision_events (church_id, event_type, occurred_at desc);

-- ---------------------------------------------------------------------------
-- Stage history — who moved where, when, and by whom
-- ---------------------------------------------------------------------------

create table stage_history (
  id                  uuid primary key default gen_random_uuid(),
  church_id           uuid not null references churches(id) on delete cascade,
  person_id           uuid not null references persons(id) on delete cascade,
  from_stage_id       uuid references growth_track_stages(id),
  to_stage_id         uuid not null references growth_track_stages(id),
  changed_at          timestamptz not null default now(),
  -- NULL = the system moved them (capture, automation, migration), not a person.
  changed_by_staff_id uuid references staff_users(id),
  reason              text,
  source              text not null default 'staff_entry'
                        check (source in ('staff_entry', 'system', 'automation', 'migration')),
  created_at          timestamptz not null default now()
);

create index stage_history_person_idx on stage_history (person_id, changed_at desc);
create index stage_history_church_idx on stage_history (church_id, changed_at desc);
