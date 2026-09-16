// The coach task list that builds itself.
//
// Overdue = days in the current stage greater than that stage's expected dwell
// days, derived at query time (no cron, no stored scheduler, no background job).
// The list is sorted most-overdue first, so the top of this page is what the church
// owes somebody today.
//
// Logging a contact writes a contact-log row and NOTHING else. It cannot move a
// stage — that stays an explicit decision on the pipeline board — and the page says
// so on screen, because a coach must never be able to misread "I called them" as
// "they moved on".

import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Badge, Notice, buttonClass, inputClass, secondaryButtonClass } from "~/components/ui";
import { durationDays, relativeDays } from "~/lib/format";
import {
  CONTACT_KINDS,
  getCoachTasks,
  logPersonInteraction,
  type CoachTaskRow,
  type ContactKind,
  type TaskScope,
} from "~/server/pipeline";

export const Route = createFileRoute("/staff/tasks")({
  validateSearch: (search: Record<string, unknown>): { scope: TaskScope } => ({
    scope: search.scope === "mine" ? "mine" : "all",
  }),
  loaderDeps: ({ search }) => ({ scope: search.scope }),
  loader: async ({ deps }) => await getCoachTasks({ data: { scope: deps.scope } }),
  component: TasksPage,
});

const KIND_LABELS: Record<ContactKind, string> = {
  call: "Call",
  text: "Text",
  email: "Email",
  in_person: "In person",
  note: "Note",
};

function TasksPage() {
  const data = Route.useLoaderData();

  if (data.state === "setup-required") {
    return (
      <Notice tone="warn" title="The task list cannot be read yet">
        {data.message} <Link to="/setup">Open the setup page</Link>.
      </Notice>
    );
  }
  if (data.state === "unauthenticated") {
    return (
      <Notice tone="bad" title="Not signed in">
        <Link to="/login">Sign in</Link> to see the task list.
      </Notice>
    );
  }

  const { tasks, scope, staffName } = data;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">Coach task list</h2>
          <p className="mt-1 text-sm text-slate-600">
            {data.overdueAll} {data.overdueAll === 1 ? "person is" : "people are"} past their
            stage&apos;s expected dwell{" "}
            {scope === "mine" ? (
              <>
                · {data.overdueMine} of them {data.overdueMine === 1 ? "is" : "are"} assigned to you
              </>
            ) : data.overdueUnassigned > 0 ? (
              <>· {data.overdueUnassigned} have no coach assigned</>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-xs uppercase tracking-wide text-slate-500">Show</span>
          <Link
            to="/staff/tasks"
            search={{ scope: "all" }}
            className={
              scope === "all"
                ? "rounded-md border border-slate-900 bg-slate-900 px-3 py-1 text-xs font-medium text-white"
                : `${secondaryButtonClass} px-3 py-1 text-xs`
            }
          >
            Everyone ({data.overdueAll})
          </Link>
          <Link
            to="/staff/tasks"
            search={{ scope: "mine" }}
            className={
              scope === "mine"
                ? "rounded-md border border-slate-900 bg-slate-900 px-3 py-1 text-xs font-medium text-white"
                : `${secondaryButtonClass} px-3 py-1 text-xs`
            }
          >
            My people ({data.overdueMine})
          </Link>
        </div>
      </div>

      <Notice tone="info" title="Logging a contact does not move anybody">
        Recording a call, text, email, visit or note adds a line to that person&apos;s contact log
        and nothing else — their stage, their dwell clock and whether they are overdue all stay
        exactly as they are. Moving somebody between stages is a separate, explicit action on the{" "}
        <Link to="/staff/pipeline">pipeline board</Link>.
      </Notice>

      {tasks.length === 0 ? (
        <Notice tone="ok" title={scope === "mine" ? "Nothing overdue on your list" : "Nothing is overdue"}>
          {scope === "mine"
            ? "Nobody assigned to you is past their stage's expected dwell time."
            : "Nobody is past their stage's expected dwell time right now."}
        </Notice>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <div className="-mx-5 overflow-x-auto px-5">
            <table className="w-full min-w-[64rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-4 font-medium">Person</th>
                  <th className="py-2 pr-4 font-medium">Stage</th>
                  <th className="py-2 pr-4 font-medium">In stage</th>
                  <th className="py-2 pr-4 font-medium">Expected</th>
                  <th className="py-2 pr-4 font-medium">Overdue</th>
                  <th className="py-2 pr-4 font-medium">Last contact</th>
                  <th className="py-2 pr-4 font-medium">Coach</th>
                  <th className="py-2 font-medium">Log contact</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {tasks.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-xs text-slate-500">
        Sorted most overdue first, computed when this page was loaded — the query reads each
        person&apos;s stage entry time and the stage&apos;s expected dwell, so nobody has to remember
        to run a report. Signed in as {staffName}.
      </p>
    </div>
  );
}

function TaskRow({ task }: { task: CoachTaskRow }) {
  return (
    <tr className="align-top">
      <td className="py-3 pr-4">
        <Link
          to="/staff/people/$id"
          params={{ id: task.id }}
          className="font-medium text-slate-900 hover:underline"
        >
          {task.fullName}
        </Link>
        <div className="mt-0.5 text-xs text-slate-500">
          {task.visitCount} {task.visitCount === 1 ? "visit" : "visits"}
          {task.lastVisitOn ? ` · last ${relativeDays(task.lastVisitOn)}` : ""}
        </div>
        {task.reviewFlag ? (
          <div className="mt-1">
            <Badge tone="warn">needs a human: {task.reviewFlag.replaceAll("_", " ")}</Badge>
          </div>
        ) : null}
      </td>
      <td className="py-3 pr-4 text-slate-700">
        {task.stageSequence}. {task.stageName}
      </td>
      <td className="py-3 pr-4 text-slate-700">{durationDays(task.daysInStage)}</td>
      <td className="py-3 pr-4 text-slate-700">{task.expectedDwellDays} days</td>
      <td className="py-3 pr-4">
        <Badge tone="bad">{task.daysOverdue} days over</Badge>
      </td>
      <td className="py-3 pr-4 text-slate-700">{relativeDays(task.lastContactOn)}</td>
      <td className="py-3 pr-4 text-slate-700">
        {task.assignedCoachName ?? <span className="text-slate-400">nobody assigned</span>}
      </td>
      <td className="py-3">
        <LogContactForm personId={task.id} personName={task.fullName} />
      </td>
    </tr>
  );
}

function LogContactForm({ personId, personName }: { personId: string; personName: string }) {
  const router = useRouter();
  const [kind, setKind] = useState<ContactKind>("call");
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setOutcome(null);
    try {
      const result = await logPersonInteraction({ data: { personId, kind, body } });
      if (result.state === "ok") {
        setBody("");
        setOutcome({ tone: "ok", text: result.message });
        await router.invalidate();
      } else if (result.state === "error") {
        setOutcome({ tone: "bad", text: result.message });
      } else {
        setOutcome({ tone: "bad", text: "You are signed out — sign in again to log a contact." });
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="w-64">
      <div className="flex items-center gap-1">
        <select
          aria-label={`How did you reach out to ${personName}?`}
          className={`${inputClass} mt-0 py-1 text-xs`}
          value={kind}
          onChange={(event) => setKind(event.target.value as ContactKind)}
        >
          {CONTACT_KINDS.map((value) => (
            <option key={value} value={value}>
              {KIND_LABELS[value]}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={pending}
          className={`${buttonClass} shrink-0 px-3 py-1 text-xs`}
        >
          {pending ? "Saving…" : "Log"}
        </button>
      </div>
      <input
        aria-label={`Note for the contact with ${personName} (optional)`}
        className={`${inputClass} mt-1 py-1 text-xs`}
        placeholder="Optional note"
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      {outcome ? (
        <p
          role="status"
          className={`mt-1 text-[11px] font-medium ${outcome.tone === "ok" ? "text-emerald-700" : "text-rose-600"}`}
        >
          {outcome.text}
        </p>
      ) : null}
    </form>
  );
}
