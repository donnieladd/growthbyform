import { Link, createFileRoute } from "@tanstack/react-router";
import { Badge, Card, Notice, Stat } from "~/components/ui";
import { getSetupState } from "~/server/setup";

export const Route = createFileRoute("/")({
  loader: async () => await getSetupState(),
  component: Home,
});

function Home() {
  const setup = Route.useLoaderData();
  const db = setup.database;

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
        Ministry operating system
      </p>
      <h1 className="mt-2 max-w-3xl text-3xl font-semibold tracking-tight text-slate-900">
        Growth Track by Form runs the one pipeline a church can&apos;t afford to lose: first-time
        guest to fully deployed, relationally-cared-for member.
      </h1>
      <p className="mt-3 max-w-3xl text-sm text-slate-600">
        One Person record and one continuous stage timeline that every part of the church reads from
        and writes to — capture, pipeline, decisions and follow-up all land on the same person.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="People" value={setup.seed.people} hint="Records in the pipeline" />
        <Stat label="Stages" value={setup.seed.stages} hint="Growth Track stages configured" />
        <Stat
          label="Staff accounts"
          value={setup.seed.staffUsers}
          hint={setup.seed.church ?? "No church seeded yet"}
        />
        <Stat
          label="Setup"
          value={setup.ready ? "Ready" : "Incomplete"}
          hint={setup.ready ? "Data path is live" : "See the setup page"}
        />
      </div>

      {!setup.ready ? (
        <div className="mt-8">
          <Notice tone="warn" title="Setup is not finished — no data has been created yet">
            {db.configured
              ? db.reachable
                ? db.migrated
                  ? "The database is connected and migrated, but the seed has not been run, so there is no church, staff account or stage list yet."
                  : "The database is connected but the schema has not been applied yet."
                : "A DATABASE_URL is present but the database could not be reached."
              : "No DATABASE_URL is set yet, so nothing is stored anywhere. Connect the database, then run the migrations and seed."}{" "}
            <Link to="/setup">Open the setup page</Link> for the exact commands.
          </Notice>
        </div>
      ) : null}

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <Card title="Connect Card" subtitle="Public intake at /connect">
          <p className="text-sm text-slate-600">
            A guest fills in their details. The card resolves to the same Person record the church
            already has — a returning guest is a second visit, never a second record.
          </p>
          <Link to="/connect" className="mt-3 inline-block text-sm font-medium text-slate-900 underline">
            Open the connect card
          </Link>
        </Card>
        <Card title="People" subtitle="Staff list at /staff/people">
          <p className="text-sm text-slate-600">
            Who is in the pipeline, where they are, how many times they have been, whether they are
            first-time or returning, and when they were last in touch.
          </p>
          <Link to="/staff/people" className="mt-3 inline-block text-sm font-medium text-slate-900 underline">
            Open the people list
          </Link>
        </Card>
        <Card title="Setup state" subtitle="Honest status at /setup">
          <p className="text-sm text-slate-600">
            Whether a database is connected, which migrations have been applied and whether the
            seed has run.
          </p>
          <Link to="/setup" className="mt-3 inline-block text-sm font-medium text-slate-900 underline">
            Open setup state
          </Link>
        </Card>
      </div>

      <div className="mt-8">
        <Card title="What this build is" subtitle="Slice 1 of the MVP">
          <ul className="space-y-2 text-sm text-slate-600">
            <li>
              <Badge tone="ok">Spine</Badge> Postgres schema, in-house staff auth, migrations and
              seed in <code className="text-xs">db/migrations</code> and <code className="text-xs">scripts/</code>.
            </li>
            <li>
              <Badge tone="ok">Capture</Badge> The public connect card resolves identity on phone,
              then email, then name + address.
            </li>
            <li>
              <Badge tone="neutral">Next</Badge> The pipeline board, stall detection and the coach
              task list are later slices — not built yet.
            </li>
          </ul>
        </Card>
      </div>
    </main>
  );
}
