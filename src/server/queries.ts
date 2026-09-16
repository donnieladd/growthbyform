// The exact SQL behind the staff screens, kept in one place so the handlers and the
// verification script (scripts/verify.ts) exercise the same statements. These
// functions take the query function as an argument, so this module imports nothing
// server-only and is safe to reference from a server-fn module.
//
// Timestamps come back as text via to_char: React will not render a JS Date, and
// formatting in SQL avoids timezone drift between the database and the browser.

import type { DashboardResult, DashboardStage, PersonListRow, PeopleSummary } from "./people";
import type {
  CoachTaskResult,
  CoachTaskRow,
  PipelineCard,
  PipelineColumn,
  PipelineResult,
  TaskScope,
} from "./pipeline";

type QueryFn = <T extends Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;

export const PEOPLE_LIST_SQL = `select
   p.id,
   p.full_name,
   s.name   as stage_name,
   s.sequence as stage_sequence,
   p.visit_count,
   to_char(p.first_visit_at, 'YYYY-MM-DD"T"HH24:MI') as first_visit_on,
   to_char(p.last_visit_at,  'YYYY-MM-DD"T"HH24:MI') as last_visit_on,
   to_char(greatest(
      coalesce(p.last_visit_at, to_timestamp(0)),
      coalesce((select max(d.occurred_at) from decision_events d where d.person_id = p.id), to_timestamp(0)),
      coalesce((select max(c.submitted_at) from connect_card_submissions c where c.person_id = p.id), to_timestamp(0))
   ), 'YYYY-MM-DD"T"HH24:MI') as last_contact_on,
   (select v.source from person_visits v where v.person_id = p.id order by v.visit_number asc limit 1) as first_source,
   (select count(*) from decision_events d where d.person_id = p.id) as decision_count,
   p.review_flag,
   h.name as household_name,
   exists (select 1 from person_visits v where v.person_id = p.id and v.visit_number >= 2) as has_second_visit
 from persons p
 left join growth_track_stages s on s.id = p.current_stage_id
 left join households h on h.id = p.household_id
where p.church_id = $1
order by s.sequence nulls last, p.last_visit_at desc nulls last, p.full_name`;

export const PEOPLE_SUMMARY_SQL = `select
   (select count(*) from persons where church_id = $1) as people,
   (select count(*) from persons where church_id = $1 and visit_count >= 2) as returning,
   (select count(*) from person_visits where church_id = $1 and visit_number = 2) as second_visits,
   (select count(*) from decision_events where church_id = $1) as decisions,
   (select count(*) from persons where church_id = $1 and review_flag is not null) as needs_review,
   (select count(*) from person_visits where church_id = $1 and attended_at >= now() - interval '7 days') as visits_7d`;

export const STAGES_SQL = `select c.id as config_id, c.name as config_name, s.id, s.name, s.sequence,
        s.expected_dwell_days, s.checkpoint_kind, s.is_terminal,
        (select count(*) from persons p where p.current_stage_id = s.id) as people
   from growth_track_configs c
   join growth_track_stages s on s.config_id = c.id
  where c.church_id = $1 and c.is_active
  order by s.sequence`;

export const DASHBOARD_TOTALS_SQL = `select
   (select count(*) from persons where church_id = $1) as people,
   (select count(*) from person_visits where church_id = $1) as visits,
   (select count(*) from person_visits where church_id = $1 and visit_number = 2) as second_visits,
   (select count(*) from persons where church_id = $1 and visit_count >= 2) as returning,
   (select count(*) from decision_events where church_id = $1) as decisions,
   (select count(*) from persons where church_id = $1 and review_flag is not null) as needs_review,
   (select count(*) from person_visits where church_id = $1 and attended_at >= now() - interval '7 days') as visits_7d,
   (select count(*) from persons p join person_stage_clock c on c.person_id = p.id
     where p.church_id = $1 and c.days_overdue > 0) as overdue`;

type PeopleRow = {
  id: string;
  full_name: string;
  stage_name: string | null;
  stage_sequence: number | null;
  visit_count: number;
  first_visit_on: string | null;
  last_visit_on: string | null;
  last_contact_on: string | null;
  first_source: string | null;
  decision_count: string;
  review_flag: string | null;
  household_name: string | null;
  has_second_visit: boolean;
};

export async function fetchPeople(
  query: QueryFn,
  churchId: string,
): Promise<{ people: PersonListRow[]; summary: PeopleSummary }> {
  const rows = await query<PeopleRow>(PEOPLE_LIST_SQL, [churchId]);
  const people: PersonListRow[] = rows.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    stageName: r.stage_name,
    stageSequence: r.stage_sequence,
    visitCount: r.visit_count,
    firstVisitOn: r.first_visit_on,
    lastVisitOn: r.last_visit_on,
    lastContactOn: r.last_contact_on,
    firstContactVia: r.first_source,
    visitStatus: r.visit_count >= 2 ? "returning" : r.visit_count === 1 ? "first-time" : "no-visits",
    isSecondVisit: r.has_second_visit,
    decisionCount: Number(r.decision_count ?? 0),
    reviewFlag: r.review_flag,
    householdName: r.household_name,
  }));

  const [summaryRow] = await query<{
    people: string;
    returning: string;
    second_visits: string;
    decisions: string;
    needs_review: string;
    visits_7d: string;
  }>(PEOPLE_SUMMARY_SQL, [churchId]);

  return {
    people,
    summary: {
      people: Number(summaryRow?.people ?? 0),
      returning: Number(summaryRow?.returning ?? 0),
      secondVisits: Number(summaryRow?.second_visits ?? 0),
      decisions: Number(summaryRow?.decisions ?? 0),
      needsReview: Number(summaryRow?.needs_review ?? 0),
      visitsLast7Days: Number(summaryRow?.visits_7d ?? 0),
    },
  };
}

export async function fetchDashboard(
  query: QueryFn,
  churchId: string,
  churchName: string,
): Promise<Extract<DashboardResult, { state: "ok" }>> {
  const stageRows = await query<{
    config_id: string;
    config_name: string;
    id: string;
    name: string;
    sequence: number;
    expected_dwell_days: number | null;
    checkpoint_kind: string | null;
    is_terminal: boolean;
    people: string;
  }>(STAGES_SQL, [churchId]);

  const [totalsRow] = await query<{
    people: string;
    visits: string;
    second_visits: string;
    returning: string;
    decisions: string;
    needs_review: string;
    visits_7d: string;
    overdue: string;
  }>(DASHBOARD_TOTALS_SQL, [churchId]);

  let checkpoints: { is_valid: boolean; errors: string[] } | null = null;
  const configId = stageRows[0]?.config_id;
  if (configId) {
    const [validation] = await query<{ is_valid: boolean; errors: string[] }>(
      `select is_valid, errors from validate_growth_track_config($1)`,
      [configId],
    );
    checkpoints = validation ?? null;
  }

  const stages: DashboardStage[] = stageRows.map((s) => ({
    id: s.id,
    name: s.name,
    sequence: s.sequence,
    expectedDwellDays: s.expected_dwell_days,
    checkpointKind: s.checkpoint_kind,
    isTerminal: s.is_terminal,
    people: Number(s.people ?? 0),
  }));

  return {
    state: "ok",
    churchName,
    configName: stageRows[0]?.config_name ?? "Growth Track",
    stages,
    totals: {
      people: Number(totalsRow?.people ?? 0),
      visits: Number(totalsRow?.visits ?? 0),
      secondVisits: Number(totalsRow?.second_visits ?? 0),
      returning: Number(totalsRow?.returning ?? 0),
      decisions: Number(totalsRow?.decisions ?? 0),
      needsReview: Number(totalsRow?.needs_review ?? 0),
      visitsLast7Days: Number(totalsRow?.visits_7d ?? 0),
      overdue: Number(totalsRow?.overdue ?? 0),
    },
    checkpoints,
  };
}

// ---------------------------------------------------------------------------
// The pipeline board. Columns are the church's OWN stages in order (never a
// hard-coded seven), each holding the people currently standing in it, with the
// clock and the contact facts a coach needs to decide who to call today.
//
// days_in_stage / days_overdue come from the person_stage_clock view, so the board
// and the task list can never disagree about who is overdue.
// ---------------------------------------------------------------------------

export const PIPELINE_CARDS_SQL = `select
   p.id,
   p.full_name,
   c.stage_id,
   c.stage_name,
   c.stage_sequence,
   c.days_in_stage,
   c.expected_dwell_days,
   c.days_overdue,
   p.visit_count,
   to_char(p.first_visit_at, 'YYYY-MM-DD"T"HH24:MI') as first_visit_on,
   to_char(p.last_visit_at,  'YYYY-MM-DD"T"HH24:MI') as last_visit_on,
   to_char(p.last_contact_at, 'YYYY-MM-DD"T"HH24:MI') as last_contact_on,
   exists (select 1 from person_visits v where v.person_id = p.id and v.visit_number >= 2) as has_second_visit,
   (select count(*) from decision_events d where d.person_id = p.id) as decision_count,
   exists (select 1 from decision_events d where d.person_id = p.id) as has_decision,
   p.review_flag,
   h.name as household_name,
   coach.name as assigned_coach_name
 from persons p
 join person_stage_clock c on c.person_id = p.id
 left join households h on h.id = p.household_id
 left join staff_users coach on coach.id = p.assigned_coach_user_id
where p.church_id = $1
order by c.stage_sequence, c.days_overdue desc nulls last, c.days_in_stage desc, p.full_name`;

// ---------------------------------------------------------------------------
// The coach task list: overdue only, most overdue first, derived at query time.
// ---------------------------------------------------------------------------

export const COACH_TASKS_SQL = `select
   p.id,
   p.full_name,
   c.stage_name,
   c.stage_sequence,
   c.days_in_stage,
   c.expected_dwell_days,
   c.days_overdue,
   to_char(p.last_contact_at, 'YYYY-MM-DD"T"HH24:MI') as last_contact_on,
   to_char(p.last_visit_at,   'YYYY-MM-DD"T"HH24:MI') as last_visit_on,
   p.visit_count,
   p.assigned_coach_user_id,
   coach.name as assigned_coach_name,
   p.review_flag
 from persons p
 join person_stage_clock c on c.person_id = p.id
 left join staff_users coach on coach.id = p.assigned_coach_user_id
where p.church_id = $1
  and c.days_overdue > 0
  and ($2::uuid is null or p.assigned_coach_user_id = $2::uuid)
order by c.days_overdue desc, c.stage_sequence, p.full_name`;

export const OVERDUE_SUMMARY_SQL = `select
   (select count(*) from persons p join person_stage_clock c on c.person_id = p.id
     where p.church_id = $1 and c.days_overdue > 0) as overdue_all,
   (select count(*) from persons p join person_stage_clock c on c.person_id = p.id
     where p.church_id = $1 and c.days_overdue > 0 and p.assigned_coach_user_id = $2) as overdue_mine,
   (select count(*) from persons p join person_stage_clock c on c.person_id = p.id
     where p.church_id = $1 and c.days_overdue > 0 and p.assigned_coach_user_id is null) as overdue_unassigned,
   (select count(*) from persons where church_id = $1 and assigned_coach_user_id = $2) as my_people`;

// One call for the dashboard callout, so /staff can show "N overdue" without
// pulling the whole board.
export const OVERDUE_COUNT_SQL = `select count(*)::int as overdue
   from persons p
   join person_stage_clock c on c.person_id = p.id
  where p.church_id = $1 and c.days_overdue > 0`;

// ---------------------------------------------------------------------------
// The read-only person record
// ---------------------------------------------------------------------------

export const PERSON_DETAIL_SQL = `select
   p.id,
   p.full_name,
   p.first_name,
   p.last_name,
   p.email,
   p.phone,
   p.visit_count,
   p.review_flag,
   p.notes,
   p.created_via,
   to_char(p.created_at, 'YYYY-MM-DD"T"HH24:MI') as created_on,
   to_char(p.first_visit_at, 'YYYY-MM-DD"T"HH24:MI') as first_visit_on,
   to_char(p.last_visit_at, 'YYYY-MM-DD"T"HH24:MI') as last_visit_on,
   to_char(p.last_contact_at, 'YYYY-MM-DD"T"HH24:MI') as last_contact_on,
   to_char(p.stage_changed_at, 'YYYY-MM-DD"T"HH24:MI') as stage_entered_on,
   p.current_stage_id,
   c.stage_name,
   c.stage_sequence,
   c.stage_key,
   c.days_in_stage,
   c.expected_dwell_days,
   c.days_overdue,
   c.is_terminal,
   h.name as household_name,
   h.address_line1,
   h.city,
   h.region,
   h.postal_code,
   h.country,
   coach.name as assigned_coach_name,
   coach.email as assigned_coach_email
 from persons p
 left join person_stage_clock c on c.person_id = p.id
 left join households h on h.id = p.household_id
 left join staff_users coach on coach.id = p.assigned_coach_user_id
where p.id = $1 and p.church_id = $2`;

export const PERSON_VISITS_SQL = `select
   v.visit_number,
   v.source,
   v.note,
   to_char(v.attended_at, 'YYYY-MM-DD"T"HH24:MI') as attended_on,
   to_char(s.submitted_at, 'YYYY-MM-DD"T"HH24:MI') as submitted_on,
   s.visit_report,
   s.how_heard,
   s.prayer_request,
   s.children_text,
   s.household_members_text,
   s.matched_on
 from person_visits v
 left join connect_card_submissions s on s.visit_id = v.id
where v.person_id = $1 and v.church_id = $2
order by v.visit_number asc`;

export const PERSON_STAGE_HISTORY_SQL = `select
   h.id,
   to_char(h.changed_at, 'YYYY-MM-DD"T"HH24:MI') as changed_on,
   fs.name as from_stage_name,
   ts.name as to_stage_name,
   h.reason,
   h.source,
   u.name as changed_by_name
 from stage_history h
 left join growth_track_stages fs on fs.id = h.from_stage_id
 left join growth_track_stages ts on ts.id = h.to_stage_id
 left join staff_users u on u.id = h.changed_by_staff_id
where h.person_id = $1 and h.church_id = $2
order by h.changed_at desc, h.created_at desc`;

export const PERSON_DECISIONS_SQL = `select
   d.id,
   d.event_type,
   to_char(d.occurred_at, 'YYYY-MM-DD"T"HH24:MI') as occurred_on,
   d.notes,
   d.source,
   s.name as stage_name_at_event,
   u.name as recorded_by_name
 from decision_events d
 left join growth_track_stages s on s.id = d.stage_id_at_event
 left join staff_users u on u.id = d.recorded_by_staff_id
where d.person_id = $1 and d.church_id = $2
order by d.occurred_at desc`;

export const PERSON_INTERACTIONS_SQL = `select
   i.id,
   i.kind,
   to_char(i.occurred_at, 'YYYY-MM-DD"T"HH24:MI') as occurred_on,
   i.body,
   u.name as staff_name
 from person_interactions i
 left join staff_users u on u.id = i.staff_user_id
where i.person_id = $1 and i.church_id = $2
order by i.occurred_at desc, i.created_at desc`;

export const PERSON_STEPS_SQL = `select
   sc.id,
   sc.step_key,
   sc.step_name,
   to_char(sc.completed_at, 'YYYY-MM-DD"T"HH24:MI') as completed_on
 from step_completions sc
where sc.person_id = $1 and sc.church_id = $2
order by sc.completed_at desc`;

export type PersonDetailRow = {
  id: string;
  fullName: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  visitCount: number;
  reviewFlag: string | null;
  notes: string | null;
  createdVia: string;
  createdOn: string | null;
  firstVisitOn: string | null;
  lastVisitOn: string | null;
  lastContactOn: string | null;
  stageEnteredOn: string | null;
  currentStageId: string | null;
  stageName: string | null;
  stageSequence: number | null;
  stageKey: string | null;
  daysInStage: number | null;
  expectedDwellDays: number | null;
  daysOverdue: number | null;
  isTerminal: boolean | null;
  householdName: string | null;
  householdAddress: string | null;
  assignedCoachName: string | null;
  assignedCoachEmail: string | null;
};

export type PersonVisitRow = {
  visitNumber: number;
  source: string;
  note: string | null;
  attendedOn: string | null;
  submittedOn: string | null;
  visitReport: string | null;
  howHeard: string | null;
  prayerRequest: string | null;
  childrenText: string | null;
  householdMembersText: string | null;
  matchedOn: string | null;
};

export type PersonStageHistoryRow = {
  id: string;
  changedOn: string | null;
  fromStageName: string | null;
  toStageName: string | null;
  reason: string | null;
  source: string;
  changedByName: string | null;
};

export type PersonDecisionRow = {
  id: string;
  eventType: string;
  occurredOn: string | null;
  notes: string | null;
  source: string;
  stageNameAtEvent: string | null;
  recordedByName: string | null;
};

export type PersonInteractionRow = {
  id: string;
  kind: string;
  occurredOn: string | null;
  body: string | null;
  staffName: string | null;
};

export type PersonStepRow = {
  id: string;
  stepKey: string;
  stepName: string | null;
  completedOn: string | null;
};

export type PersonRecord = {
  person: PersonDetailRow;
  visits: PersonVisitRow[];
  stageHistory: PersonStageHistoryRow[];
  decisions: PersonDecisionRow[];
  interactions: PersonInteractionRow[];
  steps: PersonStepRow[];
};

// ---------------------------------------------------------------------------
// Fetchers the server functions call (and scripts/verify.ts runs unchanged)
// ---------------------------------------------------------------------------

type PipelineCardRow = {
  id: string;
  full_name: string;
  stage_id: string;
  stage_name: string;
  stage_sequence: number;
  days_in_stage: number;
  expected_dwell_days: number | null;
  days_overdue: number | null;
  visit_count: number;
  first_visit_on: string | null;
  last_visit_on: string | null;
  last_contact_on: string | null;
  has_second_visit: boolean;
  decision_count: string;
  has_decision: boolean;
  review_flag: string | null;
  household_name: string | null;
  assigned_coach_name: string | null;
};

export async function fetchPipeline(
  query: QueryFn,
  churchId: string,
  churchName: string,
): Promise<Extract<PipelineResult, { state: "ok" }>> {
  const stageRows = await query<{
    id: string;
    name: string;
    sequence: number;
    expected_dwell_days: number | null;
    checkpoint_kind: string | null;
    is_terminal: boolean;
  }>(
    `select s.id, s.name, s.sequence, s.expected_dwell_days, s.checkpoint_kind, s.is_terminal
       from growth_track_configs c
       join growth_track_stages s on s.config_id = c.id
      where c.church_id = $1 and c.is_active
      order by s.sequence`,
    [churchId],
  );

  const cards = await query<PipelineCardRow>(PIPELINE_CARDS_SQL, [churchId]);

  const columns: PipelineColumn[] = stageRows.map((stage) => ({
    id: stage.id,
    name: stage.name,
    sequence: stage.sequence,
    expectedDwellDays: stage.expected_dwell_days,
    checkpointKind: stage.checkpoint_kind,
    isTerminal: stage.is_terminal,
    cards: [],
  }));
  const byStageId = new Map(columns.map((column) => [column.id, column]));

  let overdueCount = 0;
  for (const row of cards) {
    const column = byStageId.get(row.stage_id);
    if (!column) continue;
    const daysOverdue = row.days_overdue === null ? null : Number(row.days_overdue);
    const isOverdue = daysOverdue !== null && daysOverdue > 0;
    if (isOverdue) overdueCount += 1;
    const card: PipelineCard = {
      id: row.id,
      fullName: row.full_name,
      householdName: row.household_name,
      stageId: row.stage_id,
      stageName: row.stage_name,
      stageSequence: row.stage_sequence,
      daysInStage: Number(row.days_in_stage),
      expectedDwellDays: row.expected_dwell_days,
      daysOverdue,
      isOverdue,
      visitCount: Number(row.visit_count),
      firstVisitOn: row.first_visit_on,
      lastVisitOn: row.last_visit_on,
      lastContactOn: row.last_contact_on,
      visitStatus: row.visit_count >= 2 ? "returning" : row.visit_count === 1 ? "first-time" : "no-visits",
      isSecondVisit: row.has_second_visit === true,
      decisionCount: Number(row.decision_count ?? 0),
      hasDecision: row.has_decision === true,
      reviewFlag: row.review_flag,
      assignedCoachName: row.assigned_coach_name,
    };
    column.cards.push(card);
  }

  return {
    state: "ok",
    churchName,
    configName: "Growth Track",
    columns,
    overdueCount,
    totalPeople: cards.length,
  };
}

export async function fetchCoachTasks(
  query: QueryFn,
  session: { churchId: string; staffUserId: string; name: string; churchName: string },
  scope: TaskScope,
): Promise<Extract<CoachTaskResult, { state: "ok" }>> {
  const rows = await query<{
    id: string;
    full_name: string;
    stage_name: string;
    stage_sequence: number;
    days_in_stage: number;
    expected_dwell_days: number;
    days_overdue: number;
    last_contact_on: string | null;
    last_visit_on: string | null;
    visit_count: number;
    assigned_coach_user_id: string | null;
    assigned_coach_name: string | null;
    review_flag: string | null;
  }>(COACH_TASKS_SQL, [session.churchId, scope === "mine" ? session.staffUserId : null]);

  const [summary] = await query<{
    overdue_all: string;
    overdue_mine: string;
    overdue_unassigned: string;
    my_people: string;
  }>(OVERDUE_SUMMARY_SQL, [session.churchId, session.staffUserId]);

  const tasks: CoachTaskRow[] = rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    stageName: row.stage_name,
    stageSequence: row.stage_sequence,
    daysInStage: Number(row.days_in_stage),
    expectedDwellDays: Number(row.expected_dwell_days),
    daysOverdue: Number(row.days_overdue),
    lastContactOn: row.last_contact_on,
    lastVisitOn: row.last_visit_on,
    visitCount: Number(row.visit_count),
    assignedCoachName: row.assigned_coach_name,
    assignedCoachUserId: row.assigned_coach_user_id,
    reviewFlag: row.review_flag,
  }));

  return {
    state: "ok",
    churchName: session.churchName,
    staffName: session.name,
    staffUserId: session.staffUserId,
    scope,
    tasks,
    overdueAll: Number(summary?.overdue_all ?? 0),
    overdueMine: Number(summary?.overdue_mine ?? 0),
    overdueUnassigned: Number(summary?.overdue_unassigned ?? 0),
    myPeople: Number(summary?.my_people ?? 0),
  };
}

export async function fetchPersonRecord(
  query: QueryFn,
  churchId: string,
  personId: string,
): Promise<PersonRecord | null> {
  const [person] = await query<{
    id: string;
    full_name: string;
    first_name: string;
    last_name: string;
    email: string | null;
    phone: string | null;
    visit_count: number;
    review_flag: string | null;
    notes: string | null;
    created_via: string;
    created_on: string | null;
    first_visit_on: string | null;
    last_visit_on: string | null;
    last_contact_on: string | null;
    stage_entered_on: string | null;
    current_stage_id: string | null;
    stage_name: string | null;
    stage_sequence: number | null;
    stage_key: string | null;
    days_in_stage: number | null;
    expected_dwell_days: number | null;
    days_overdue: number | null;
    is_terminal: boolean | null;
    household_name: string | null;
    address_line1: string | null;
    city: string | null;
    region: string | null;
    postal_code: string | null;
    country: string | null;
    assigned_coach_name: string | null;
    assigned_coach_email: string | null;
  }>(PERSON_DETAIL_SQL, [personId, churchId]);
  if (!person) return null;

  const address = [person.address_line1, person.city, person.region, person.postal_code, person.country]
    .filter((part) => part !== null && part !== undefined && String(part).trim() !== "")
    .join(", ");

  const visits = await query<{
    visit_number: number;
    source: string;
    note: string | null;
    attended_on: string | null;
    submitted_on: string | null;
    visit_report: string | null;
    how_heard: string | null;
    prayer_request: string | null;
    children_text: string | null;
    household_members_text: string | null;
    matched_on: string | null;
  }>(PERSON_VISITS_SQL, [personId, churchId]);

  const stageHistory = await query<{
    id: string;
    changed_on: string | null;
    from_stage_name: string | null;
    to_stage_name: string | null;
    reason: string | null;
    source: string;
    changed_by_name: string | null;
  }>(PERSON_STAGE_HISTORY_SQL, [personId, churchId]);

  const decisions = await query<{
    id: string;
    event_type: string;
    occurred_on: string | null;
    notes: string | null;
    source: string;
    stage_name_at_event: string | null;
    recorded_by_name: string | null;
  }>(PERSON_DECISIONS_SQL, [personId, churchId]);

  const interactions = await query<{
    id: string;
    kind: string;
    occurred_on: string | null;
    body: string | null;
    staff_name: string | null;
  }>(PERSON_INTERACTIONS_SQL, [personId, churchId]);

  const steps = await query<{
    id: string;
    step_key: string;
    step_name: string | null;
    completed_on: string | null;
  }>(PERSON_STEPS_SQL, [personId, churchId]);

  return {
    person: {
      id: person.id,
      fullName: person.full_name,
      firstName: person.first_name,
      lastName: person.last_name,
      email: person.email,
      phone: person.phone,
      visitCount: Number(person.visit_count),
      reviewFlag: person.review_flag,
      notes: person.notes,
      createdVia: person.created_via,
      createdOn: person.created_on,
      firstVisitOn: person.first_visit_on,
      lastVisitOn: person.last_visit_on,
      lastContactOn: person.last_contact_on,
      stageEnteredOn: person.stage_entered_on,
      currentStageId: person.current_stage_id,
      stageName: person.stage_name,
      stageSequence: person.stage_sequence,
      stageKey: person.stage_key,
      daysInStage: person.days_in_stage === null ? null : Number(person.days_in_stage),
      expectedDwellDays: person.expected_dwell_days,
      daysOverdue: person.days_overdue === null ? null : Number(person.days_overdue),
      isTerminal: person.is_terminal,
      householdName: person.household_name,
      householdAddress: address.length > 0 ? address : null,
      assignedCoachName: person.assigned_coach_name,
      assignedCoachEmail: person.assigned_coach_email,
    },
    visits: visits.map((v) => ({
      visitNumber: Number(v.visit_number),
      source: v.source,
      note: v.note,
      attendedOn: v.attended_on,
      submittedOn: v.submitted_on,
      visitReport: v.visit_report,
      howHeard: v.how_heard,
      prayerRequest: v.prayer_request,
      childrenText: v.children_text,
      householdMembersText: v.household_members_text,
      matchedOn: v.matched_on,
    })),
    stageHistory: stageHistory.map((h) => ({
      id: h.id,
      changedOn: h.changed_on,
      fromStageName: h.from_stage_name,
      toStageName: h.to_stage_name,
      reason: h.reason,
      source: h.source,
      changedByName: h.changed_by_name,
    })),
    decisions: decisions.map((d) => ({
      id: d.id,
      eventType: d.event_type,
      occurredOn: d.occurred_on,
      notes: d.notes,
      source: d.source,
      stageNameAtEvent: d.stage_name_at_event,
      recordedByName: d.recorded_by_name,
    })),
    interactions: interactions.map((i) => ({
      id: i.id,
      kind: i.kind,
      occurredOn: i.occurred_on,
      body: i.body,
      staffName: i.staff_name,
    })),
    steps: steps.map((s) => ({
      id: s.id,
      stepKey: s.step_key,
      stepName: s.step_name,
      completedOn: s.completed_on,
    })),
  };
}
