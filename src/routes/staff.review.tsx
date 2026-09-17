// The review queue. Capture never guesses a merge — a possible duplicate gets
// a review_flag instead of being silently combined or silently duplicated.
// This page is where that flag actually gets resolved by a human.

import { Link, createFileRoute } from "@tanstack/react-router";
import { Badge, Card, Notice } from "~/components/ui";
import { formatDay } from "~/lib/format";
import { getReviewQueue, reviewFlagLabel } from "~/server/review";

export const Route = createFileRoute("/staff/review")({
  loader: async () => await getReviewQueue(),
  component: ReviewQueuePage,
});

function ReviewQueuePage() {
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
        <Link to="/login">Sign in</Link> to review flagged records.
      </Notice>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Needs review</h2>
        <p className="mt-1 text-sm text-slate-600">
          Capture refuses to guess when two people might be the same person — it creates a record and
          flags it instead of silently merging or silently duplicating. Resolve each one: merge it
          into the real record, or confirm it's genuinely a different person.
        </p>
      </div>

      {data.people.length === 0 ? (
        <Notice tone="ok" title="Nothing flagged right now">
          Every capture so far either matched cleanly or created a clean new record.
        </Notice>
      ) : (
        <Card>
          <div className="-mx-5 overflow-x-auto px-5">
            <table className="w-full min-w-[42rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-2 pr-4 font-medium">Person</th>
                  <th className="py-2 pr-4 font-medium">Why it's flagged</th>
                  <th className="py-2 pr-4 font-medium">Contact</th>
                  <th className="py-2 pr-4 font-medium">Captured</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.people.map((person) => (
                  <tr key={person.id} className="align-top">
                    <td className="py-3 pr-4 font-medium text-slate-900">{person.fullName}</td>
                    <td className="py-3 pr-4">
                      <Badge tone="warn">{reviewFlagLabel(person.reviewFlag)}</Badge>
                    </td>
                    <td className="py-3 pr-4 text-slate-700">
                      {person.email ?? "—"}
                      <div className="text-xs text-slate-500">{person.phone ?? "no phone"}</div>
                    </td>
                    <td className="py-3 pr-4 text-slate-700">{formatDay(person.createdOn)}</td>
                    <td className="py-3">
                      <Link
                        to="/staff/review/$id"
                        params={{ id: person.id }}
                        className="text-sm font-medium text-slate-900 hover:underline"
                      >
                        Review →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
