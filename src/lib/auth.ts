// Staff auth primitives, built in-house on node:crypto. No third-party auth service.
//
//   * Passwords: scrypt (N=16384, r=8, p=1, 64-byte key) with a 16-byte random
//     salt. The stored string is self-describing — scrypt$N$r$p$salt$key — so the
//     cost parameters can be raised later without invalidating old hashes.
//   * Sessions: a 32-byte random opaque token is handed to the caller, which puts
//     it in an httpOnly cookie; the database only ever stores its SHA-256, so a
//     dump of staff_sessions cannot be replayed.
//
// Server-only. `crypto` is imported as a default import on purpose: named imports
// from an externalized node builtin break the client build even though this module
// never runs in a browser (it is only reached from server-fn handlers).

import crypto from "node:crypto";
import { MIN_PASSWORD_LENGTH, SESSION_COOKIE, SESSION_TTL_DAYS } from "./session-constants";

export { MIN_PASSWORD_LENGTH, SESSION_COOKIE, SESSION_TTL_DAYS };

const SCRYPT = { N: 16_384, r: 8, p: 1, keyLength: 64, maxmem: 64 * 1024 * 1024 } as const;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password.normalize("NFKC"), salt, SCRYPT.keyLength, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  return [
    "scrypt",
    String(SCRYPT.N),
    String(SCRYPT.r),
    String(SCRYPT.p),
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], "base64url");
    const expected = Buffer.from(parts[5], "base64url");
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
    const actual = crypto.scryptSync(password.normalize("NFKC"), salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT.maxmem,
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Returns a human-readable problem, or null when the password is acceptable. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${String(MIN_PASSWORD_LENGTH)} characters.`;
  }
  if (/^\s|\s$/.test(password)) return "Password must not start or end with a space.";
  return null;
}

export function newSessionToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function sessionExpiry(from = new Date()): Date {
  return new Date(from.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
}
