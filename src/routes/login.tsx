import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { Card, Field, Notice, buttonClass, inputClass } from "~/components/ui";
import { getStaffSession, signInStaff } from "~/server/session";
import { getSetupState } from "~/server/setup";

export const Route = createFileRoute("/login")({
  loader: async () => {
    const [session, setup] = await Promise.all([getStaffSession(), getSetupState()]);
    if (session.state === "signed-in") {
      throw redirect({ to: "/staff" });
    }
    return { setup, dbUnavailable: session.state === "db-unavailable" ? session.message : null };
  },
  component: LoginPage,
});

function LoginPage() {
  const { setup, dbUnavailable } = Route.useLoaderData();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const canSignIn = setup.database.reachable && setup.database.migrated && setup.seed.staffUsers > 0;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    try {
      const result = await signInStaff({ data: { email, password } });
      if (result.ok) {
        // A full navigation, so the server guard sees the new session cookie.
        window.location.assign("/staff");
        return;
      }
      setMessage(result.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-md px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Staff sign in</h1>
      <p className="mt-2 text-sm text-slate-600">
        Growth Track is staff-facing. Sign in to see the pipeline.
      </p>

      {!canSignIn ? (
        <div className="mt-6 space-y-3">
          <Notice tone="warn" title="Sign-in is not available yet">
            {dbUnavailable
              ? dbUnavailable
              : !setup.database.configured
                ? "No database is connected, so there are no staff accounts to sign in with."
                : !setup.database.reachable
                  ? "The database is configured but could not be reached."
                  : !setup.database.migrated
                    ? "The schema has not been applied yet."
                    : "No staff accounts exist yet — the seed has not been run."}{" "}
            <Link to="/setup">Open the setup page</Link> for the exact commands.
          </Notice>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-6">
          <Card>
            <div className="space-y-4">
              <Field label="Email" htmlFor="email">
                <input
                  id="email"
                  type="email"
                  autoComplete="username"
                  className={inputClass}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Field label="Password" htmlFor="password">
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  className={inputClass}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              {message ? (
                <p className="text-sm font-medium text-rose-600" role="alert">
                  {message}
                </p>
              ) : null}
              <button type="submit" className={buttonClass} disabled={pending}>
                {pending ? "Signing in…" : "Sign in"}
              </button>
            </div>
          </Card>
        </form>
      )}

      {setup.seed.staffUsers > 0 ? (
        <p className="mt-4 text-xs text-slate-500">
          Seeded demo account: <code className="text-xs">pastor@demo.church</code> — the password is in
          the engineer notes. Change it before this church holds real data.
        </p>
      ) : null}
    </main>
  );
}
