// Server-only session logic: sessions are proven here, never in the browser.
//
// Nothing in this file imports a request API or a cookie helper — it takes the
// cookie value as an argument. That keeps it free of any import that TanStack
// Start's import-protection would refuse to bundle for the client, so the
// server-fn modules can call into it safely while reading the cookie themselves.

import {
  SESSION_TTL_DAYS,
  hashPassword,
  hashToken,
  newSessionToken,
  sessionExpiry,
  verifyPassword,
} from "../lib/auth";
import { DbUnavailableError, query } from "../lib/pg";
import { normalizeEmailLower } from "../lib/normalize";

export type StaffSession = {
  staffUserId: string;
  churchId: string;
  email: string;
  name: string;
  role: string;
  churchName: string;
  churchSlug: string;
};

export type SessionState =
  | ({ state: "signed-in" } & StaffSession)
  | { state: "signed-out" }
  | { state: "db-unavailable"; message: string };

type SessionRow = {
  session_id: string;
  staff_user_id: string;
  church_id: string;
  email: string;
  name: string;
  role: string;
  church_name: string;
  church_slug: string;
};

// A throwaway hash so a sign-in attempt for an unknown email costs the same scrypt
// work as a real one — no free "does this account exist?" oracle.
let dummyHash: string | null = null;
function burnPasswordTime(password: string): void {
  dummyHash ??= hashPassword(`dummy-${String(Math.random())}`);
  verifyPassword(password, dummyHash);
}

/** Resolve the opaque cookie token to a staff session, or say why we cannot. */
export async function readStaffSession(token: string | null | undefined): Promise<SessionState> {
  if (!token) return { state: "signed-out" };
  try {
    const rows = await query<SessionRow>(
      `select s.id as session_id, u.id as staff_user_id, u.church_id, u.email, u.name, u.role,
              c.name as church_name, c.slug as church_slug
         from staff_sessions s
         join staff_users u on u.id = s.staff_user_id
         join churches c on c.id = u.church_id
        where s.token_hash = $1
          and s.revoked_at is null
          and s.expires_at > now()
          and u.is_active`,
      [hashToken(token)],
    );
    const row = rows[0];
    if (!row) return { state: "signed-out" };
    void query(`update staff_sessions set last_seen_at = now() where id = $1`, [row.session_id]).catch(
      () => undefined,
    );
    return {
      state: "signed-in",
      staffUserId: row.staff_user_id,
      churchId: row.church_id,
      email: row.email,
      name: row.name,
      role: row.role,
      churchName: row.church_name,
      churchSlug: row.church_slug,
    };
  } catch (err) {
    // Any failure to read the session table means we cannot prove who is asking —
    // so nobody is signed in. It is reported as a setup problem rather than a 500,
    // because that is what it is: no database, no migrations, or no seed.
    const message =
      err instanceof DbUnavailableError
        ? err.message
        : `The database could not be read: ${err instanceof Error ? err.message : String(err)}`;
    return { state: "db-unavailable", message };
  }
}

/** For server functions that return data: proves who is asking before any query. */
export async function requireStaff(
  token: string | null | undefined,
): Promise<
  { ok: true; session: StaffSession } | { ok: false; state: "signed-out" | "db-unavailable"; message?: string }
> {
  const session = await readStaffSession(token);
  if (session.state === "signed-in") {
    const { state: _state, ...rest } = session;
    return { ok: true, session: rest };
  }
  if (session.state === "db-unavailable") {
    return { ok: false, state: "db-unavailable", message: session.message };
  }
  return { ok: false, state: "signed-out" };
}

export type SignInOutcome =
  | { ok: true; token: string; maxAgeSeconds: number }
  | { ok: false; message: string };

/** Verify credentials, open a session row, and hand back the raw cookie token. */
export async function signInWithPassword(
  rawEmail: string,
  password: string,
  meta: { userAgent: string | null } = { userAgent: null },
): Promise<SignInOutcome> {
  const emailLower = normalizeEmailLower(rawEmail);
  if (!emailLower || password.length === 0) {
    // Same wording either way: an unauthenticated caller learns nothing about which
    // accounts exist.
    return { ok: false, message: "Enter your email and password." };
  }
  try {
    const candidates = await query<{ id: string; church_id: string; password_hash: string }>(
      `select id, church_id, password_hash from staff_users
        where email_lower = $1 and is_active
        order by created_at asc`,
      [emailLower],
    );

    if (candidates.length === 0) {
      burnPasswordTime(password);
      return { ok: false, message: "Email or password is incorrect." };
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        message: "More than one staff account uses that email. Ask an owner to make them unique.",
      };
    }

    const staff = candidates[0];
    if (!verifyPassword(password, staff.password_hash)) {
      return { ok: false, message: "Email or password is incorrect." };
    }

    const { token, tokenHash } = newSessionToken();
    await query(
      `insert into staff_sessions (church_id, staff_user_id, token_hash, expires_at, user_agent)
       values ($1, $2, $3, $4, $5)`,
      [staff.church_id, staff.id, tokenHash, sessionExpiry(), meta.userAgent],
    );
    await query(`update staff_users set last_sign_in_at = now() where id = $1`, [staff.id]);

    return { ok: true, token, maxAgeSeconds: SESSION_TTL_DAYS * 24 * 60 * 60 };
  } catch (err) {
    if (err instanceof DbUnavailableError) return { ok: false, message: err.message };
    throw err;
  }
}

export async function revokeSession(token: string | null | undefined): Promise<void> {
  if (!token) return;
  await query(`update staff_sessions set revoked_at = now() where token_hash = $1`, [
    hashToken(token),
  ]).catch(() => undefined);
}
