// The pipeline board — columns are this church's own stages, in order, read from
// growth_track_stages. Nothing here hard-codes the seven default names: a church
// that configures its own track gets its own columns.
//
// Moving somebody is an explicit control on the card (a select + button, not a
// fiddly drag): it calls a server function that writes the stage_history row and
// restarts the dwell clock. Logging a contact lives on the task list, and it
// deliberately cannot move anybody.

import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Badge, Notice, inputClass, secondaryButtonClass } from "~/components/ui";
import { durationDays, relativeDays } from "~/lib/format";
import {
  getPipelineBoard,
  movePersonStage,
  type PipelineCard,
  type PipelineColumn,
} from "~/server/pipeline";

export const Route = createFileRoute("/staff/pipeline")({
  loader: async () => await getPipelineBoard(),
  component: PipelinePage,
});

function visitBadge(card: PipelineCard): { tone: "ok" | "info" | "neutral" | "warn"; label: string } {
  if (card.isSecondVisit || card.visitCount >= 2) {
    return { tone: "ok", label: `Returning · visit ${String(card.visitCount)}` };
  }
  if (card.visitCount === 1) return { tone: "warn", label: "First-time guest" };
  return { tone: "neutral", label: "No visit recorded" };
}

function PipelinePage() {
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
        <Link to="/login">Sign in</Link> to see the pipeline.
      </Notice>
    );
  }

  const { columns, overdueCount, totalPeople } = data;
  const stageOptions = columns.map((column) => ({ id: column.id, name: column.name }));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">Pipeline</h2>
          <p className="mt-1 text-sm text-slate-600">
            {totalPeople} {totalPeople === 1 ? "person" : "people"} on the track across{" "}
            {columns.length} stages ·{" "}
            <Link to="/staff/tasks" className="font-medium underline">
              {overdueCount} overdue
            </Link>
          </p>
        </div>
        <p className="max-w-md text-xs text-slate-500">
          Overdue means days in the current stage is greater than that stage&apos;s expected dwell
          time. It is derived at read time from the stage entry stamp — there is no report to run.
        </p>
      </div>

      {columns.length === 0 ? (
        <Notice tone="info" title="No Growth Track stages configured">
          This church has no active track stages yet, so there is nothing to show on the board.
        </Notice>
      ) : (
        <div className="-mx-6 overflow-x-auto px-6 pb-2">
          <div className="flex min-w-max gap-4 align-top">
            {columns.map((column) => (
              <StageColumn key={column.id} column={column} stageOptions={stageOptions} />
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-slate-500">
        A card moves only when somebody moves it — and every move is recorded in the person&apos;s
        stage history with who moved them and when.
      </p>
    </div>
  );
}

function StageColumn({
  column,
  stageOptions,
}: {
  column: PipelineColumn;
  stageOptions: { id: string; name: string }[];
}) {
  const overdueInColumn = column.cards.filter((card) => card.isOverdue).length;

  return (
    <section className="w-72 shrink-0 rounded-lg border border-slate-200 bg-slate-100/60">
      <header className="rounded-t-lg border-b border-slate-200 bg-white px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold text-slate-900">
            <span className="text-slate-400">{column.sequence}.</span> {column.name}
          </p>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
            {column.cards.length}
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          {column.expectedDwellDays === null
            ? "No dwell expectation (terminal stage)"
            : `Expected dwell: ${String(column.expectedDwellDays)} days`}
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {overdueInColumn > 0 ? (
            <Badge tone="bad">
              {overdueInColumn} overdue
            </Badge>
          ) : null}
          {column.isTerminal ? <Badge tone="neutral">Terminal</Badge> : null}
        </div>
      </header>

      <div className="space-y-2 p-2">
        {column.cards.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-slate-400">Nobody in this stage</p>
        ) : (
          column.cards.map((card) => (
            <PersonCard key={card.id} card={card} stageOptions={stageOptions} />
          ))
        )}
      </div>
    </section>
  );
}

function PersonCard({
  card,
  stageOptions,
}: {
  card: PipelineCard;
  stageOptions: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [target, setTarget] = useState(card.stageId);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const visit = visitBadge(card);

  async function onMove() {
    setPending(true);
    setOutcome(null);
    try {
      const result = await movePersonStage({ data: { personId: card.id, toStageId: target } });
      if (result.state === "ok") {
        setOutcome({ tone: "ok", text: result.message });
        await router.invalidate();
      } else if (result.state === "error") {
        setOutcome({ tone: "bad", text: result.message });
      } else {
        setOutcome({ tone: "bad", text: "You are signed out — sign in again to move somebody." });
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="rounded-md border border-slate-200 bg-white p-3 shadow-sm">
      <Link
        to="/staff/people/$id"
        params={{ id: card.id }}
        className="text-sm font-medium text-slate-900 hover:underline"
      >
        {card.fullName}
      </Link>
      {card.householdName ? <p className="text-xs text-slate-500">{card.householdName}</p> : null}

      <div className="mt-2 flex flex-wrap gap-1">
        <Badge tone={visit.tone}>{visit.label}</Badge>
        {card.hasDecision ? <Badge tone="info">Decision recorded</Badge> : null}
        {card.isOverdue ? (
          <Badge tone="bad">{String(card.daysOverdue)} days overdue</Badge>
        ) : (
          <Badge tone="ok">On pace</Badge>
        )}
      </div>

      <dl className="mt-2 space-y-0.5 text-xs text-slate-600">
        <div className="flex justify-between gap-2">
          <dt>In this stage</dt>
          <dd className="font-medium text-slate-900">
            {durationDays(card.daysInStage)}
            {card.expectedDwellDays === null ? "" : ` of ${String(card.expectedDwellDays)}`}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Last contact</dt>
          <dd className="font-medium text-slate-900">{relativeDays(card.lastContactOn)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Visits</dt>
          <dd className="font-medium text-slate-900">{card.visitCount}</dd>
        </div>
        {card.assignedCoachName ? (
          <div className="flex justify-between gap-2">
            <dt>Coach</dt>
            <dd className="font-medium text-slate-900">{card.assignedCoachName}</dd>
          </div>
        ) : null}
      </dl>

      {card.reviewFlag ? (
        <p className="mt-2 text-xs text-amber-700">
          Needs a human: {card.reviewFlag.replaceAll("_", " ")}
        </p>
      ) : null}

      <div className="mt-3 border-t border-slate-100 pt-2">
        <label
          className="block text-xs font-medium text-slate-500"
          htmlFor={`move-${card.id}`}
        >
          Move to stage
        </label>
        <div className="mt-1 flex gap-2">
          <select
            id={`move-${card.id}`}
            aria-label={`Move ${card.fullName} to stage`}
            className={`${inputClass} mt-0 py-1 text-xs`}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            {stageOptions.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onMove}
            disabled={pending || target === card.stageId}
            className={`${secondaryButtonClass} shrink-0 px-3 py-1 text-xs`}
          >
            {pending ? "Moving…" : "Move"}
          </button>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-slate-400">
          Moving restarts the dwell clock for the new stage.
        </p>
        {outcome ? (
          <p
            role="status"
            className={`mt-1 text-xs font-medium ${outcome.tone === "ok" ? "text-emerald-700" : "text-rose-600"}`}
          >
            {outcome.text}
          </p>
        ) : null}
      </div>
    </article>
  );
}
