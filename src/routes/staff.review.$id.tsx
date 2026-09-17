// Resolve one flagged person: merge them into whoever they actually are, or
// confirm they're genuinely a different person and clear the flag.
//
// Merging is not reversible from this screen — it re-points history onto the
// record you keep and deletes the other row. person_merges keeps an audit
// snapshot (src/server/review.ts), but there's no "undo" button here on
// purpose: a wrong merge needs a human looking at the audit trail, not a
// one-click reversal that could just as easily un-merge a correct one.

import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Badge, Card, Notice, buttonClass, inputClass, secondaryButtonClass } from "~/components/ui";
import { formatDay } from "~/lib/format";
import {
  dismissReviewFlag,
  getMergeCandidates,
  mergePersons,
  reviewFlagLabel,
  searchPeople,
  type PersonSummary,
} from "~/server/review";

export const Route = createFileRoute("/staff/review/$id")({
  loader: async ({ params }) => await getMergeCandidates({ data: { personId: params.id } }),
  component: ReviewPersonPage,
});

function SummaryCard({ person, highlight }: { person: PersonSummary; highlight?: boolean }) {
  return (
    <div className={`rounded-md border p-3 ${highlight ? "border-slate-400 bg-slate-50" : "border-slate-200"}`}>
      <p className="font-medium text-slate-900">{person.fullName}</p>
      <dl className="mt-1 space-y-0.5 text-xs text-slate-600">
        <div>{person.email ?? "no email"} · {person.phone ?? "no phone"}</div>
        <div>{person.householdName ?? "no household"}</div>
        <div>{person.stageName ?? "not on the track"} · {person.visitCount} visit(s) · {person.decisionCount} decision(s)</div>
        <div>captured {formatDay(person.createdOn)}</div>
      </dl>
      {person.reviewFlag ? (
        <div className="mt-2">
          <Badge tone="warn">{reviewFlagLabel(person.reviewFlag)}</Badge>
        </div>
      ) : null}
    </div>
  );
}

function ReviewPersonPage() {
  const data = Route.useLoaderData();

  if (data.state === "setup-required") {
    return (
      <Notice tone="warn" title="Nothing to review yet">
        {data.message} <Link to="/setup">Open the setup page</Link>.
      </Notice>
    );
  }
  if (data.state === "unauthenticated") {
    return (
      <Notice tone="bad" title="Not signed in">
        <Link to="/login">Sign in</Link> to review this record.
      </Notice>
    );
  }
  if (data.state === "not-found") {
    return (
      <Notice tone="info" title="No such person in this church">
        That record does not exist here, or has already been resolved.{" "}
        <Link to="/staff/review">Back to the review queue</Link>.
      </Notice>
    );
  }

  return <ReviewPersonEditor initial={data} />;
}

function ReviewPersonEditor({
  initial,
}: {
  initial: Extract<Awaited<ReturnType<typeof getMergeCandidates>>, { state: "ok" }>;
}) {
  const router = useRouter();
  const { person } = initial;
  const candidates = initial.candidates;
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PersonSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [keepId, setKeepId] = useState<string>(person.id);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const target = [...candidates, ...searchResults].find((c) => c.id === targetId) ?? null;

  async function onSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const result = await searchPeople({ data: { query: searchQuery, excludeId: person.id } });
      if (result.state === "ok") setSearchResults(result.results);
    } finally {
      setSearching(false);
    }
  }

  function pickTarget(candidateId: string) {
    setTargetId(candidateId);
    setKeepId(person.id);
    setOutcome(null);
  }

  async function onMerge() {
    if (!target) return;
    const mergeId = keepId === person.id ? target.id : person.id;
    setPending(true);
    setOutcome(null);
    try {
      const result = await mergePersons({ data: { keepId, mergeId, reason } });
      if (result.state === "ok") {
        await router.navigate({ to: "/staff/review" });
      } else if (result.state === "error") {
        setOutcome({ tone: "bad", text: result.message });
      } else {
        setOutcome({ tone: "bad", text: "You are signed out — sign in again to merge." });
      }
    } catch {
      setOutcome({ tone: "bad", text: "Could not reach the server — check your connection and try again." });
    } finally {
      setPending(false);
    }
  }

  async function onDismiss() {
    setPending(true);
    setOutcome(null);
    try {
      const result = await dismissReviewFlag({ data: { personId: person.id } });
      if (result.state === "ok") {
        await router.navigate({ to: "/staff/review" });
      } else if (result.state === "error") {
        setOutcome({ tone: "bad", text: result.message });
      } else {
        setOutcome({ tone: "bad", text: "You are signed out — sign in again." });
      }
    } catch {
      setOutcome({ tone: "bad", text: "Could not reach the server — check your connection and try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <Link to="/staff/review" className="text-xs text-slate-500 hover:underline">
          ← Review queue
        </Link>
        <h2 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">Resolve: {person.fullName}</h2>
      </div>

      <Card title="The flagged record">
        <SummaryCard person={person} />
        <button
          type="button"
          disabled={pending}
          onClick={onDismiss}
          className={`${secondaryButtonClass} mt-3 text-xs`}
        >
          Not a duplicate — clear the flag
        </button>
      </Card>

      <Card
        title={`Possible matches (${String(candidates.length)})`}
        subtitle="Same phone, email, or exact name — the same signals capture itself checks"
      >
        {candidates.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing matched automatically. Search below.</p>
        ) : (
          <div className="space-y-2">
            {candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => pickTarget(c.id)}
                className={`block w-full rounded-md border p-3 text-left ${targetId === c.id ? "border-slate-400 bg-slate-50" : "border-slate-200 hover:border-slate-300"}`}
              >
                <p className="text-sm font-medium text-slate-900">{c.fullName}</p>
                <p className="text-xs text-slate-500">
                  {c.email ?? "no email"} · {c.phone ?? "no phone"} · {c.visitCount} visit(s)
                </p>
              </button>
            ))}
          </div>
        )}

        <form onSubmit={onSearch} className="mt-4 flex gap-2">
          <input
            className={`${inputClass} mt-0`}
            placeholder="Search by name to find someone not listed above"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          <button type="submit" disabled={searching} className={`${secondaryButtonClass} shrink-0`}>
            {searching ? "Searching…" : "Search"}
          </button>
        </form>
        {searchResults.length > 0 ? (
          <div className="mt-2 space-y-2">
            {searchResults.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => pickTarget(c.id)}
                className={`block w-full rounded-md border p-3 text-left ${targetId === c.id ? "border-slate-400 bg-slate-50" : "border-slate-200 hover:border-slate-300"}`}
              >
                <p className="text-sm font-medium text-slate-900">{c.fullName}</p>
                <p className="text-xs text-slate-500">
                  {c.email ?? "no email"} · {c.phone ?? "no phone"} · {c.visitCount} visit(s)
                </p>
              </button>
            ))}
          </div>
        ) : null}
      </Card>

      {target ? (
        <Card title="Merge">
          <div className="grid gap-3 sm:grid-cols-2">
            <label
              className={`cursor-pointer rounded-md border p-1 ${keepId === person.id ? "border-slate-400" : "border-transparent"}`}
            >
              <input
                type="radio"
                name="keep"
                className="sr-only"
                checked={keepId === person.id}
                onChange={() => setKeepId(person.id)}
              />
              <SummaryCard person={person} highlight={keepId === person.id} />
              <p className="mt-1 text-center text-xs font-medium text-slate-700">Keep this one</p>
            </label>
            <label
              className={`cursor-pointer rounded-md border p-1 ${keepId === target.id ? "border-slate-400" : "border-transparent"}`}
            >
              <input
                type="radio"
                name="keep"
                className="sr-only"
                checked={keepId === target.id}
                onChange={() => setKeepId(target.id)}
              />
              <SummaryCard person={target} highlight={keepId === target.id} />
              <p className="mt-1 text-center text-xs font-medium text-slate-700">Keep this one</p>
            </label>
          </div>

          <p className="mt-3 text-xs text-slate-600">
            The record you don't keep is removed — its visits, decisions, stage history and contact
            log all move onto the one you keep first, nothing is lost, but the extra person record
            itself is gone afterward. This can't be undone from this screen.
          </p>

          <input
            className={`${inputClass} mt-2`}
            placeholder="Optional note — why these are the same person"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />

          <div className="mt-3 flex items-center gap-3">
            <button type="button" disabled={pending} onClick={onMerge} className={buttonClass}>
              {pending ? "Merging…" : `Merge — keep ${keepId === person.id ? person.fullName : target.fullName}`}
            </button>
            <button type="button" onClick={() => setTargetId(null)} className={secondaryButtonClass}>
              Cancel
            </button>
          </div>
        </Card>
      ) : null}

      {outcome ? (
        <p
          role="status"
          className={`text-sm font-medium ${outcome.tone === "ok" ? "text-emerald-700" : "text-rose-600"}`}
        >
          {outcome.text}
        </p>
      ) : null}
    </div>
  );
}
