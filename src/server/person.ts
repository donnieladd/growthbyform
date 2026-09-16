// The read-only person record. Display only: recording decision events, editing
// details and merging duplicates are slice 3.
//
// Same server/client discipline as the other server-fn modules: nothing
// server-only is imported at module scope, and the SQL lives in ./queries.ts.

import { createServerFn } from "@tanstack/react-start";
import { SESSION_COOKIE } from "../lib/session-constants";
import { fetchPersonRecord } from "./queries";
import type { PersonRecord } from "./queries";

export type PersonRecordResult =
  | { state: "ok"; churchName: string; record: PersonRecord }
  | { state: "not-found" }
  | { state: "unauthenticated" }
  | { state: "setup-required"; message: string };

export const getPersonRecord = createServerFn({ method: "GET" })
  .validator((input: { personId?: unknown }) => ({
    personId: typeof input?.personId === "string" ? input.personId : "",
  }))
  .handler(async ({ data }): Promise<PersonRecordResult> => {
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
    if (!data.personId) return { state: "not-found" };

    // A malformed id would make Postgres raise; treat it as "no such person"
    // rather than a 500 on a page that is only reading.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.personId)) {
      return { state: "not-found" };
    }

    const record = await fetchPersonRecord(query, auth.session.churchId, data.personId);
    if (!record) return { state: "not-found" };
    return { state: "ok", churchName: auth.session.churchName, record };
  });
