import { Link, createFileRoute } from "@tanstack/react-router";
import { Badge, Card, KeyValue, Notice } from "~/components/ui";
import { getConnectionInfo, getSetupState } from "~/server/setup";

export const Route = createFileRoute("/setup")({
  loader: async () => {
    const [setup, connection] = await Promise.all([getSetupState(), getConnectionInfo()]);
    return { setup, connection };
  },
  component: SetupPage,
});

function SetupPage() {
  const { setup, connection } = Route.useLoaderData();
  const db = setup.database;

  const dbTone = !db.configured ? "warn" : db.reachable && db.migrated ? "ok" : "bad";

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Setup state</h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-600">
        Exactly what this deployment has: whether a database is connected, which migrations have
        been applied, and whether there is any data. Nothing here is mocked — if a number is zero,
        it is zero.
      </p>

      <div className="mt-6 space-y-6">
        <Card
          title="Database connection"
          subtitle="The app reads DATABASE_URL from the environment only — never from a .env file."
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={dbTone as "ok" | "warn" | "bad"}>
              {!db.configured
                ? "No DATABASE_URL"
                : db.reachable
                  ? "Reachable"
                  : "Configured but unreachable"}
            </Badge>
            {connection.configured ? <Badge tone="info">{connection.driver}</Badge> : null}
          </div>
          <div className="mt-4">
            <KeyValue
              items={[
                {
                  label: "DATABASE_URL",
                  value: connection.configured ? "set" : "not set",
                },
                { label: "Host", value: connection.configured ? connection.host : "—" },
                { label: "Database", value: connection.configured ? connection.database : "—" },
                { label: "TLS", value: connection.configured ? connection.tls : "—" },
                {
                  label: "Tables present",
                  value: `${String(db.migratedTables)} / ${String(db.expectedTables)}`,
                },
                {
                  label: "Server",
                  value: db.serverVersion ? db.serverVersion.split(" on ")[0] : "—",
                },
              ]}
            />
          </div>
          {db.error ? (
            <div className="mt-4">
              <Notice tone={dbTone as "warn" | "bad"} title={db.error.reason}>
                {db.error.message}
              </Notice>
            </div>
          ) : null}
        </Card>

        <Card title="Migrations" subtitle="db/migrations/*.sql, applied in filename order">
          {setup.migrations.length === 0 ? (
            <p className="text-sm text-slate-600">
              No migration files were found on disk. They live in{" "}
              <code className="text-xs">db/migrations/</code> at the root of the site.
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {setup.migrations.map((m) => (
                <li key={m.filename} className="flex items-center justify-between gap-4">
                  <code className="text-xs text-slate-700">{m.filename}</code>
                  <Badge tone={m.applied ? "ok" : "warn"}>{m.applied ? "applied" : "pending"}</Badge>
                </li>
              ))}
            </ul>
          )}
          {setup.pendingMigrations.length > 0 ? (
            <div className="mt-4">
              <Notice tone="warn" title={`${String(setup.pendingMigrations.length)} migration(s) pending`}>
                Run <code className="text-xs">bun run db:migrate</code> from the site directory to
                apply them. The runner records every applied file in{" "}
                <code className="text-xs">schema_migrations</code>.
              </Notice>
            </div>
          ) : null}
        </Card>

        <Card title="Seed" subtitle="Church, staff account, the seven stages, demo people">
          <KeyValue
            items={[
              { label: "Church", value: setup.seed.church ?? "none" },
              { label: "Churches", value: setup.seed.churches },
              { label: "Staff accounts", value: setup.seed.staffUsers },
              { label: "Growth Track stages", value: setup.seed.stages },
              { label: "People", value: setup.seed.people },
            ]}
          />
          {!setup.seed.configured && db.reachable && db.migrated ? (
            <div className="mt-4">
              <Notice tone="warn" title="Nothing is seeded yet">
                Run <code className="text-xs">bun run db:seed</code> to create the demo church, a
                staff sign-in, the seven default stages and the demo people.
              </Notice>
            </div>
          ) : null}
        </Card>

        <Card title="Running this locally" subtitle="The exact sequence">
          <ol className="list-inside list-decimal space-y-2 text-sm text-slate-600">
            <li>
              Provide <code className="text-xs">DATABASE_URL</code> as an environment variable (any
              standard Postgres connection string; include <code className="text-xs">sslmode=require</code>{" "}
              if the provider requires TLS).
            </li>
            <li>
              <code className="text-xs">bun run db:migrate</code> — applies every pending migration
              and records it.
            </li>
            <li>
              <code className="text-xs">bun run db:seed</code> — one church, one staff account, the
              seven stages with expected dwell times, and demo people.
            </li>
            <li>
              <Link to="/login" className="underline">
                Sign in
              </Link>{" "}
              with the seeded staff account, then open{" "}
              <Link to="/staff/people" className="underline">
                People
              </Link>
              .
            </li>
          </ol>
        </Card>
      </div>
    </main>
  );
}
