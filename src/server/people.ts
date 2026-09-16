// Staff people list + dashboard counts. Server-only data access: every function
// here is a createServerFn, guarded by requireStaff(), and returns strings — never
// a JS Date — because React refuses to render Date objects handed across the wire.
//
// Everything that touches cookies or Postgres is imported inside a handler body so
// the client bundle only ever sees the RPC stubs. The SQL itself lives in
// ./queries.ts, where scripts/verify.ts runs the very same statements.

import { createServerFn } from "@tanstack/react-start";
import { SESSION_COOKIE } from "../lib/session-constants";
import { fetchDashboard, fetchPeople } from "./queries";

export type PersonListRow = {
  id: string;
  fullName: string;
  stageName: string | null;
  stageSequence: number | null;
  visitCount: number;
  firstVisitOn: string | null;
  lastVisitOn: string | null;
  lastContactOn: string | null;
  firstContactVia: string | null;
  visitStatus: "first-time" | "returning" | "no-visits";
  isSecondVisit: boolean;
  decisionCount: number;
  reviewFlag: string | null;
  householdName: string | null;
};

export type PeopleSummary = {
  people: number;
  returning: number;
  secondVisits: number;
  decisions: number;
  needsReview: number;
  visitsLast7Days: number;
};

export type PeopleListResult =
  | { state: "ok"; churchName: string; people: PersonListRow[]; summary: PeopleSummary }
  | { state: "unauthenticated" }
  | { state: "setup-required"; message: string };

export const listPeople = createServerFn({ method: "GET" }).handler(
  async (): Promise<PeopleListResult> => {
    const [{ getCookie }, { requireStaff }, { query }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("./auth-core"),
      import("../lib/pg"),
    ]);

    const auth = await requireStaff(getCookie(SESSION_COOKIE));
    if (!auth.ok) {
      if (auth.state === "db-unavailable") {
        return { state: "setup-required", message: auth.message ?? "The database is not reachable." };
      }
      return { state: "unauthenticated" };
    }

    const { people, summary } = await fetchPeople(query, auth.session.churchId);
    return { state: "ok", churchName: auth.session.churchName, people, summary };
  },
);

export type DashboardStage = {
  id: string;
  name: string;
  sequence: number;
  expectedDwellDays: number | null;
  checkpointKind: string | null;
  isTerminal: boolean;
  people: number;
};

export type DashboardTotals = {
  people: number;
  visits: number;
  secondVisits: number;
  returning: number;
  decisions: number;
  needsReview: number;
  visitsLast7Days: number;
  /** People past their current stage's expected dwell — derived, never stored. */
  overdue: number;
};

export type DashboardResult =
  | {
      state: "ok";
      churchName: string;
      configName: string;
      stages: DashboardStage[];
      totals: DashboardTotals;
      checkpoints: { is_valid: boolean; errors: string[] } | null;
    }
  | { state: "unauthenticated" }
  | { state: "setup-required"; message: string };

export const getDashboard = createServerFn({ method: "GET" }).handler(
  async (): Promise<DashboardResult> => {
    const [{ getCookie }, { requireStaff }, { query }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("./auth-core"),
      import("../lib/pg"),
    ]);

    const auth = await requireStaff(getCookie(SESSION_COOKIE));
    if (!auth.ok) {
      if (auth.state === "db-unavailable") {
        return { state: "setup-required", message: auth.message ?? "The database is not reachable." };
      }
      return { state: "unauthenticated" };
    }

    return await fetchDashboard(query, auth.session.churchId, auth.session.churchName);
  },
);
