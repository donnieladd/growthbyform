import { Link, createFileRoute } from "@tanstack/react-router";
import { Badge, Card, Notice } from "~/components/ui";
import { formatDay, relativeDays, sourceLabel } from "~/lib/format";
import { listPeople } from "~/server/people";

export const Route = createFileRoute("/staff/people")({
  loader: async () => await listPeople(),
  component: PeoplePage,
});

function visitBadge(row: {
  visitStatus: string;
  visitCount: number;
  isSecondVisit: boolean;
}): { tone: "ok" | "info" | "neutral" | "warn"; label: string } {
  switch (row.visitStatus) {
    case "second-visit":
      return { tone: "ok", label: "Returning · visit 2" };
    case "returning":
      return { tone: "info", label: `Returning · visit ${String(row.visitCount)}` };
    case "first-time":
      return { tone: "warn", label: "First-time guest" };
    default:
      return { tone: "neutral", label: "No visit recorded" };
  }
}

function PeoplePage() {
  const data = Route.useLoaderData();

  if (data.state === "setup-required") {
    return (
      <Notice tone="warn" title="The pipeline cannot be read yet">
        {data.message} <Link to="/setup">Open the setup page</Link>.
      </Notice>
    );
  }
  if (data.state === "unauthenticated") {
    return (
      <Notice tone="bad" title="Not signed in">
        <Link to="/login">Sign in</Link> to see people.
      </Notice>
    );
  }

  const { people, summary } = data;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">People</h2>
        <p className="mt-1 text-sm text-slate-600">
          {summary.people} {summary.people === 1 ? "person" : "people"} in the pipeline ·{" "}
          {summary.secondVisits} second {summary.secondVisits === 1 ? "visit" : "visits"} ·{" "}
          {summary.decisions} recorded {summary.decisions === 1 ? "decision" : "decisions"}
          {summary.needsReview > 0 ? ` · ${String(summary.needsReview)} need a human check` : ""}
        </p>
      </div>

      {summary.needsReview > 0 ? (
        <Notice tone="warn" title={`${String(summary.needsReview)} record(s) flagged during capture`}>
          Capture refuses to guess when two people might be the same person. Those records carry a
          flag so somebody can merge them — a possible duplicate stays visible instead of quietly
          creating a twin. <Link to="/staff/review" className="font-medium underline">Open the review queue</Link>.
        </Notice>
      ) : null}

      {people.length === 0 ? (
        <Notice tone="info" title="No people yet">
          Nothing has been captured on this church yet. Submit the{" "}
          <Link to="/connect">public connect card</Link> and the person lands here.
        </Notice>
      ) : (
        <Card>
          <div className="-mx-5 overflow-x-auto px-5">
            <table className="w-full min-w-[46rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-4 font-medium">Person</th>
                  <th className="py-2 pr-4 font-medium">Stage</th>
                  <th className="py-2 pr-4 font-medium">Visits</th>
                  <th className="py-2 pr-4 font-medium">First / returning</th>
                  <th className="py-2 pr-4 font-medium">Last contact</th>
                  <th className="py-2 font-medium">Decisions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {people.map((person) => {
                  const badge = visitBadge(person);
                  return (
                    <tr key={person.id} className="align-top">
                      <td className="py-3 pr-4">
                        <Link
                          to="/staff/people/$id"
                          params={{ id: person.id }}
                          className="font-medium text-slate-900 hover:underline"
                        >
                          {person.fullName}
                        </Link>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {person.householdName ? `${person.householdName} · ` : ""}
                          first seen via {sourceLabel(person.firstContactVia)}
                        </div>
                        {person.reviewFlag ? (
                          <div className="mt-1">
                            <Link to="/staff/review/$id" params={{ id: person.id }}>
                              <Badge tone="warn">needs a human: {person.reviewFlag.replaceAll("_", " ")}</Badge>
                            </Link>
                          </div>
                        ) : null}
                      </td>
                      <td className="py-3 pr-4 text-slate-700">
                        {person.stageName ?? <span className="text-slate-400">not on the track</span>}
                      </td>
                      <td className="py-3 pr-4 text-slate-700">
                        <span className="font-medium">{person.visitCount}</span>
                        <div className="text-xs text-slate-500">
                          {person.firstVisitOn ? `first ${formatDay(person.firstVisitOn)}` : "—"}
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                      </td>
                      <td className="py-3 pr-4 text-slate-700">
                        {relativeDays(person.lastContactOn)}
                        <div className="text-xs text-slate-500">
                          {person.lastVisitOn ? `last visit ${formatDay(person.lastVisitOn)}` : "no visit"}
                        </div>
                      </td>
                      <td className="py-3 text-slate-700">
                        {person.decisionCount > 0 ? (
                          <Badge tone="ok">
                            {person.decisionCount} recorded
                          </Badge>
                        ) : (
                          <span className="text-slate-400">none</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="text-xs text-slate-500">
        &ldquo;First-time&rdquo; and &ldquo;returning&rdquo; come from real visit rows
        (person_visits.visit_number), not from a flag somebody has to remember to set. Second visits
        are the strongest predictor that someone assimilates.
      </p>
    </div>
  );
}
