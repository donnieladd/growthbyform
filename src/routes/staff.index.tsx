import { Link, createFileRoute } from "@tanstack/react-router";
import { Badge, Card, Notice, Stat } from "~/components/ui";
import { checkpointLabel } from "~/lib/format";
import { getDashboard } from "~/server/people";

export const Route = createFileRoute("/staff/")({
  loader: async () => await getDashboard(),
  component: StaffOverview,
});

function StaffOverview() {
  const data = Route.useLoaderData();

  if (data.state === "setup-required") {
    return (
      <Notice tone="warn" title="Nothing to show yet — the database is not ready">
        {data.message} <Link to="/setup">Open the setup page</Link>.
      </Notice>
    );
  }
  if (data.state === "unauthenticated") {
    return (
      <Notice tone="bad" title="Not signed in">
        <Link to="/login">Sign in</Link> to see the pipeline.
      </Notice>
    );
  }

  return (
    <div className="space-y-6">
      {data.totals.overdue > 0 ? (
        <Notice
          tone={data.totals.overdue >= 3 ? "bad" : "warn"}
          title={`${String(data.totals.overdue)} ${data.totals.overdue === 1 ? "person is" : "people are"} past their stage's expected dwell`}
        >
          The task list is already built — nobody had to run a report to find them.{" "}
          <Link to="/staff/tasks" className="font-medium">
            Open the coach task list
          </Link>
          .
        </Notice>
      ) : (
        <Notice tone="ok" title="Nobody is overdue">
          No one is past their current stage&apos;s expected dwell time.{" "}
          <Link to="/staff/tasks" className="font-medium">
            Open the coach task list
          </Link>
          .
        </Notice>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat label="People" value={data.totals.people} hint="One record per person, church-wide" />
        <Stat
          label="Overdue"
          value={data.totals.overdue}
          hint="Past the current stage's expected dwell — derived, never stored"
        />
        <Stat
          label="Second visits"
          value={data.totals.secondVisits}
          hint="The strongest assimilation signal"
        />
        <Stat label="Visits (7 days)" value={data.totals.visitsLast7Days} hint={`${String(data.totals.visits)} all time`} />
        <Stat label="Decisions recorded" value={data.totals.decisions} hint="Salvation, rededication, baptism" />
        <Stat
          label="Needs a human"
          value={data.totals.needsReview}
          hint="Flagged during capture — possible duplicates"
        />
        <Stat
          label="People who came back"
          value={data.totals.returning}
          hint="Two or more recorded visits"
        />
      </div>

      <Card
        title={`${data.configName} stages`}
        subtitle="Where the pipeline stands. Expected dwell is what stall detection reads: past it, somebody appears on the task list on their own."
      >
        <ul className="divide-y divide-slate-100">
          {data.stages.map((stage) => (
            <li key={stage.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">
                  {stage.sequence}. {stage.name}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span>
                    Expected dwell:{" "}
                    {stage.expectedDwellDays === null ? "no expectation (terminal)" : `${String(stage.expectedDwellDays)} days`}
                  </span>
                  {checkpointLabel(stage.checkpointKind) ? (
                    <Badge tone="info">{checkpointLabel(stage.checkpointKind)}</Badge>
                  ) : null}
                  {stage.isTerminal ? <Badge tone="neutral">Terminal</Badge> : null}
                </p>
              </div>
              <div className="text-right">
                <p className="text-lg font-semibold text-slate-900">{stage.people}</p>
                <p className="text-xs text-slate-500">people</p>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title="Checkpoint rules"
        subtitle="Belonging required first · self-understanding required before deployment · leadership/character optional · deployment required last"
      >
        {data.checkpoints ? (
          data.checkpoints.is_valid ? (
            <Badge tone="ok">This track satisfies the checkpoint rules</Badge>
          ) : (
            <div className="space-y-2">
              <Badge tone="bad">This track breaks the checkpoint rules</Badge>
              <ul className="list-inside list-disc text-sm text-rose-700">
                {data.checkpoints.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          )
        ) : (
          <p className="text-sm text-slate-600">
            No active Growth Track config exists yet, so there are no rules to check.
          </p>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Checked by <code className="text-xs">validate_growth_track_config()</code> in the database.
          The config editor that calls it is a later slice.
        </p>
      </Card>

      <div className="flex flex-wrap gap-4 text-sm">
        <Link to="/staff/pipeline" className="font-medium underline">
          Open the pipeline board
        </Link>
        <Link to="/staff/tasks" className="font-medium underline">
          Open the coach task list
        </Link>
        <Link to="/staff/people" className="underline">
          Open the people list
        </Link>
        <Link to="/connect" className="underline">
          Open the public connect card
        </Link>
      </div>
    </div>
  );
}
