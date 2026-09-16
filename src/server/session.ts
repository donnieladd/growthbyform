// Staff session server functions. This module is imported by routes, so — apart
// from createServerFn itself — it imports NOTHING server-only at module scope.
// Everything that touches cookies or the database is pulled in inside a handler
// body, which TanStack Start strips from the client bundle. (An import at module
// scope would drag node:crypto or pg into the browser bundle, and the framework
// refuses that import outright.)
//
// The guard is applied in two places on purpose:
//   1. the /staff route tree's beforeLoad redirects an unauthenticated visitor, and
//   2. every server function that returns data calls requireStaff() itself,
// so a route that forgets the first one still cannot leak data to a client.

import { createServerFn } from "@tanstack/react-start";
import { SESSION_COOKIE } from "../lib/session-constants";
import type { SessionState } from "./auth-core";

export type { SessionState, StaffSession } from "./auth-core";

export type SignInResult = { ok: true } | { ok: false; message: string };

export const getStaffSession = createServerFn({ method: "GET" }).handler(
  async (): Promise<SessionState> => {
    const [{ getCookie }, { readStaffSession }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("./auth-core"),
    ]);
    return readStaffSession(getCookie(SESSION_COOKIE));
  },
);

export const signInStaff = createServerFn({ method: "POST" })
  .validator((input: { email?: unknown; password?: unknown }) => ({
    email: typeof input?.email === "string" ? input.email : "",
    password: typeof input?.password === "string" ? input.password : "",
  }))
  .handler(async ({ data }): Promise<SignInResult> => {
    const [{ setCookie, getRequestHeader }, { signInWithPassword }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("./auth-core"),
    ]);

    const outcome = await signInWithPassword(data.email, data.password, {
      userAgent: getRequestHeader("user-agent") ?? null,
    });
    if (!outcome.ok) return { ok: false, message: outcome.message };

    setCookie(SESSION_COOKIE, outcome.token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: outcome.maxAgeSeconds,
      // x-forwarded-proto is client-suppliable and only safe to trust behind a
      // proxy that overwrites it before the app sees it — which we can't assume
      // by default. COOKIE_SECURE lets a real deployment declare that guarantee
      // explicitly instead of inferring it from a spoofable header:
      //   COOKIE_SECURE=true  — always mark the cookie secure (set this once the
      //                         production proxy is confirmed to terminate TLS).
      //   COOKIE_SECURE=false — never mark it secure (local/plain-http dev).
      //   unset               — fall back to sniffing x-forwarded-proto, which is
      //                         what the sandbox's http-forwarding proxy needs.
      secure:
        process.env.COOKIE_SECURE === "true"
          ? true
          : process.env.COOKIE_SECURE === "false"
            ? false
            : getRequestHeader("x-forwarded-proto") === "https",
    });
    return { ok: true };
  });

export const signOutStaff = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ ok: boolean }> => {
    const [{ deleteCookie, getCookie }, { revokeSession }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("./auth-core"),
    ]);
    await revokeSession(getCookie(SESSION_COOKIE));
    deleteCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  },
);
