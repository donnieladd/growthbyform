import { Link, Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { getStaffSession, signOutStaff } from "~/server/session";
import { secondaryButtonClass } from "~/components/ui";

// The guard. Every /staff/* route inherits this beforeLoad, so an unauthenticated
// visitor is redirected before any staff component renders — server-side on the
// first request, and again on the client for in-app navigation.
export const Route = createFileRoute("/staff")({
  beforeLoad: async () => {
    const session = await getStaffSession();
    if (session.state === "db-unavailable") {
      throw redirect({ to: "/setup" });
    }
    if (session.state !== "signed-in") {
      throw redirect({ to: "/login" });
    }
    return { session };
  },
  component: StaffLayout,
});

function StaffLayout() {
  const { session } = Route.useRouteContext();
  const staff = session as { name: string; email: string; churchName: string; role: string };

  async function onSignOut() {
    await signOutStaff();
    window.location.assign("/login");
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
            {staff.churchName}
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">
            Staff workspace
          </h1>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <Link
              to="/staff"
              className="text-slate-600 hover:text-slate-900"
              activeProps={{ className: "font-medium text-slate-900" }}
              activeOptions={{ exact: true }}
            >
              Overview
            </Link>
            <Link
              to="/staff/pipeline"
              className="text-slate-600 hover:text-slate-900"
              activeProps={{ className: "font-medium text-slate-900" }}
            >
              Pipeline
            </Link>
            <Link
              to="/staff/tasks"
              className="text-slate-600 hover:text-slate-900"
              activeProps={{ className: "font-medium text-slate-900" }}
            >
              Coach tasks
            </Link>
            <Link
              to="/staff/people"
              className="text-slate-600 hover:text-slate-900"
              activeProps={{ className: "font-medium text-slate-900" }}
            >
              People
            </Link>
            <Link
              to="/staff/review"
              className="text-slate-600 hover:text-slate-900"
              activeProps={{ className: "font-medium text-slate-900" }}
            >
              Review
            </Link>
          </div>
        </div>
        <div className="text-right text-xs text-slate-500">
          <p className="font-medium text-slate-700">{staff.name}</p>
          <p>{staff.email}</p>
          <button type="button" onClick={onSignOut} className={`${secondaryButtonClass} mt-2`}>
            Sign out
          </button>
        </div>
      </div>

      <div className="mt-6">
        <Outlet />
      </div>
    </main>
  );
}
