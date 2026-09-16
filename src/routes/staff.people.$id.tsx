// The read-only person record. One person, everything the church knows, in one
// place: contact details, household, what they told us on the way in, where they
// stand on the track and how long they have stood there, every stage move, every
// decision, and every contact anybody has logged.
//
// Display only — recording decision events, editing and merging are slice 3.

import { Link, createFileRoute } from "@tanstack/react-router";
import { Badge, Card, KeyValue, Notice } from "~/components/ui";
import {
  decisionLabel,
  durationDays,
  formatDay,
  formatStamp,
  interactionLabel,
  relativeDays,
  sourceLabel,
  VISIT_REPORT_LABELS,
} from "~/lib/format";
import { getPersonRecord } from "~/server/person";

export const Route = createFileRoute("/staff/people/$id")({
  loader: async ({ params }) => await getPersonRecord({ data: { personId: params.id } }),
  component: PersonRecordPage,
});

function PersonRecordPage() {
  const data = Route.useLoaderData();

  if (data.state === "setup-required") {
    return (
      <Notice tone="warn" title="This record cannot be read yet">
        {data.message} <Link to="/setup">Open the setup page</Link>.
      </Notice>
    );
  }
  if (data.state === "unauthenticated") {
    return (
      <Notice tone="bad" title="Not signed in">
        <Link to="/login">Sign in</Link> to read this record.
      </Notice>
    );
  }
  if (data.state === "not-found") {
    return (
      <Notice tone="info" title="No such person in this church">
        That record does not exist here. It may belong to another church, or the link may be stale.{" "}
        <Link to="/staff/people">Back to the people list</Link>.
      </Notice>
    );
  }

  const { person, visits, stageHistory, decisions, interactions, steps } = data.record;
  const overdue = person.daysOverdue !== null && person.daysOverdue > 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/staff/people" className="text-xs text-slate-500 hover:underline">
            ← All people
          </Link>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">
            {person.fullName}
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            {person.stageName
              ? `${person.stageName} for ${durationDays(person.daysInStage ?? 0)}`
              : "Not on the track yet"}
            {person.householdName ? ` · ${person.householdName}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap gap-1">
            {person.visitCount >= 2 ? (
              <Badge tone="ok">Returning · visit {person.visitCount}</Badge>
            ) : person.visitCount === 1 ? (
              <Badge tone="warn">First-time guest</Badge>
            ) : (
              <Badge tone="neutral">No visit recorded</Badge>
            )}
            {overdue ? <Badge tone="bad">{person.daysOverdue} days overdue</Badge> : null}
            {person.assignedCoachName ? (
              <Badge tone="info">Coach: {person.assignedCoachName}</Badge>
            ) : (
              <Badge tone="neutral">No coach assigned</Badge>
            )}
            {person.reviewFlag ? (
              <Badge tone="warn">needs a human: {person.reviewFlag.replaceAll("_", " ")}</Badge>
            ) : null}
          </div>
        </div>
        <Link to="/staff/pipeline" className="text-sm font-medium underline">
          Open the pipeline board
        </Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Who they are" subtitle="Contact details and household">
          <KeyValue
            items={[
              { label: "Email", value: person.email ?? "—" },
              { label: "Phone", value: person.phone ?? "—" },
              { label: "Household", value: person.householdName ?? "—" },
              { label: "Address", value: person.householdAddress ?? "—" },
              { label: "First captured", value: formatDay(person.createdOn) },
              { label: "First captured via", value: sourceLabel(person.createdVia) },
            ]}
          />
        </Card>

        <Card
          title="Where they stand"
          subtitle="The dwell clock stall detection reads, derived when this page loaded"
        >
          <KeyValue
            items={[
              { label: "Current stage", value: person.stageName ?? "not on the track" },
              { label: "Stage entered", value: formatStamp(person.stageEnteredOn) },
              { label: "Time in stage", value: durationDays(person.daysInStage ?? 0) },
              {
                label: "Expected dwell",
                value: person.expectedDwellDays === null ? "none (terminal)" : `${person.expectedDwellDays} days`,
              },
              {
                label: "Overdue",
                value: person.expectedDwellDays === null
                  ? "not applicable"
                  : overdue
                    ? `${person.daysOverdue} days past expectation`
                    : "on pace",
              },
              { label: "Last contact", value: relativeDays(person.lastContactOn) },
              { label: "Visits", value: String(person.visitCount) },
            ]}
          />
        </Card>
      </div>

      <Card
        title={`Visit history (${visits.length})`}
        subtitle="First and second visits are distinct, differently-urgent facts — they come from real visit rows, never a flag somebody set"
      >
        {visits.length === 0 ? (
          <p className="text-sm text-slate-500">No visits recorded yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {visits.map((visit) => (
              <li key={visit.visitNumber} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={visit.visitNumber === 1 ? "warn" : visit.visitNumber === 2 ? "ok" : "info"}>
                    {visit.visitNumber === 1 ? "First visit" : `Visit #${visit.visitNumber}`}
                  </Badge>
                  {visit.visitNumber === 2 ? <Badge tone="info">Came back — strongest signal</Badge> : null}
                  <span className="text-sm font-medium text-slate-900">
                    {formatDay(visit.attendedOn)}
                  </span>
                  <span className="text-xs text-slate-500">
                    {sourceLabel(visit.source)}
                    {visit.matchedOn
                      ? ` · matched on ${visit.matchedOn.replaceAll("_", " ")}`
                      : ""}
                  </span>
                </div>
                {visit.visitReport ? (
                  <p className="mt-1 text-xs text-slate-600">
                    They {VISIT_REPORT_LABELS[visit.visitReport] ?? visit.visitReport}.
                    {visit.howHeard ? ` Heard about us via ${visit.howHeard}.` : ""}
                  </p>
                ) : null}
                {visit.prayerRequest ? (
                  <p className="mt-1 rounded-md border border-sky-100 bg-sky-50 px-2 py-1 text-xs text-sky-900">
                    Prayer request: {visit.prayerRequest}
                  </p>
                ) : null}
                {visit.childrenText || visit.householdMembersText ? (
                  <p className="mt-1 text-xs text-slate-500">
                    {visit.householdMembersText ? `Household: ${visit.householdMembersText}. ` : ""}
                    {visit.childrenText ? `Kids: ${visit.childrenText}.` : ""}
                  </p>
                ) : null}
                {visit.note ? <p className="mt-1 text-xs text-slate-500">{visit.note}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title={`Stage history (${stageHistory.length})`}
          subtitle="Every move, who made it, and why — including the stage they started in"
        >
          {stageHistory.length === 0 ? (
            <p className="text-sm text-slate-500">Nobody has moved this person yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {stageHistory.map((entry) => (
                <li key={entry.id} className="py-3">
                  <p className="text-sm text-slate-900">
                    {entry.fromStageName ?? "—"} → <span className="font-medium">{entry.toStageName}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {formatStamp(entry.changedOn)} ·{" "}
                    {entry.changedByName ? `${entry.changedByName} (staff)` : "system"} ·{" "}
                    {sourceLabel(entry.source)}
                  </p>
                  {entry.reason ? (
                    <p className="mt-0.5 text-xs text-slate-600">{entry.reason}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title={`Decision events (${decisions.length})`}
          subtitle="Repeatable, timestamped facts — stored separately from stage and step completion"
        >
          {decisions.length === 0 ? (
            <p className="text-sm text-slate-500">No decisions recorded.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {decisions.map((decision) => (
                <li key={decision.id} className="py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="ok">{decisionLabel(decision.eventType)}</Badge>
                    <span className="text-sm font-medium text-slate-900">
                      {formatDay(decision.occurredOn)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {decision.recordedByName ? `Recorded by ${decision.recordedByName}` : "Recorded"}
                    {decision.stageNameAtEvent
                      ? ` · at the time they stood at ${decision.stageNameAtEvent}`
                      : ""}
                  </p>
                  {decision.notes ? <p className="mt-0.5 text-xs text-slate-600">{decision.notes}</p> : null}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-500">
            A decision never moves anybody on the board — the stage shown above is a separate fact.
          </p>
        </Card>

        <Card
          title={`Contact log (${interactions.length})`}
          subtitle="What the church actually did — a call, a text, an email, a visit or a note"
        >
          {interactions.length === 0 ? (
            <p className="text-sm text-slate-500">
              Nobody has logged a contact with this person yet. The task list is where contacts get
              logged.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {interactions.map((interaction) => (
                <li key={interaction.id} className="py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="info">{interactionLabel(interaction.kind)}</Badge>
                    <span className="text-sm font-medium text-slate-900">
                      {formatStamp(interaction.occurredOn)}
                    </span>
                  </div>
                  {interaction.body ? (
                    <p className="mt-1 text-sm text-slate-700">{interaction.body}</p>
                  ) : null}
                  <p className="mt-0.5 text-xs text-slate-500">
                    {interaction.staffName ? `Logged by ${interaction.staffName}` : "Logged automatically"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={`Step completions (${steps.length})`} subtitle="Growth Track sessions and milestones">
          {steps.length === 0 ? (
            <p className="text-sm text-slate-500">No steps completed yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {steps.map((step) => (
                <li key={step.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="text-sm text-slate-900">{step.stepName ?? step.stepKey}</span>
                  <span className="text-xs text-slate-500">{formatDay(step.completedOn)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <p className="text-xs text-slate-500">
        Recording a decision event, editing details and merging possible duplicates are the next
        slice. This page only reads.
      </p>
    </div>
  );
}
