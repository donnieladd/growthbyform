// Public connect card submission. Server-side only: the browser posts the form and
// the server resolves identity, records the visit and answers with the person's
// next step. The client never talks to the database.
//
// Cookie-free, but it still keeps every Postgres import inside a handler body so
// nothing server-only lands in the client bundle.

import { createServerFn } from "@tanstack/react-start";
import { normalizeEmailLower, normalizePhoneE164 } from "../lib/normalize";
import { resolveConnectCard, type ConnectCardInput, type VisitReport } from "./identity";

export type ConnectCardFormInput = {
  firstName?: unknown;
  lastName?: unknown;
  email?: unknown;
  phone?: unknown;
  addressLine1?: unknown;
  addressLine2?: unknown;
  city?: unknown;
  region?: unknown;
  postalCode?: unknown;
  visitReport?: unknown;
  children?: unknown;
  householdMembers?: unknown;
  howHeard?: unknown;
  prayerRequest?: unknown;
  /** Honeypot: a real person never fills this in. */
  website?: unknown;
};

export type ConnectCardResult =
  | {
      state: "ok";
      fullName: string;
      visitNumber: number;
      isFirstVisit: boolean;
      isSecondVisit: boolean;
      personCreated: boolean;
      matchedOn: string;
      nextStep: { title: string; detail: string };
      currentStageName: string | null;
      reviewFlag: string | null;
    }
  | { state: "invalid"; errors: Record<string, string> }
  | { state: "setup-required"; message: string }
  | { state: "error"; message: string };

const str = (value: unknown, max = 400): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

// Best-effort in-process rate limit. It is not a security boundary (a second
// process or a restart resets it) — it just stops a scripted flood of junk people.
const submissions = new Map<string, number[]>();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 8;

function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (submissions.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  submissions.set(key, recent);
  if (submissions.size > 5_000) submissions.clear();
  return recent.length > RATE_MAX;
}

export const submitConnectCard = createServerFn({ method: "POST" })
  .validator((input: ConnectCardFormInput) => input ?? {})
  .handler(async ({ data }): Promise<ConnectCardResult> => {
    const [{ getRequestHeader, getRequestIP }, pg] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("../lib/pg"),
    ]);
    const { DbUnavailableError, query, withTransaction } = pg;

    const firstName = str(data.firstName, 80);
    const lastName = str(data.lastName, 80);
    const email = str(data.email, 200);
    const phone = str(data.phone, 40);
    const visitReportRaw = str(data.visitReport, 20);

    // Honeypot tripped: answer like a success and write nothing.
    if (str(data.website, 100).length > 0) {
      return {
        state: "ok",
        fullName: `${firstName} ${lastName}`.trim() || "Guest",
        visitNumber: 1,
        isFirstVisit: true,
        isSecondVisit: false,
        personCreated: false,
        matchedOn: "no_match_created",
        nextStep: { title: "Thank you", detail: "We'll be in touch." },
        currentStageName: null,
        reviewFlag: null,
      };
    }

    let ip = "unknown";
    try {
      ip = getRequestIP({ xForwardedFor: true }) ?? "unknown";
    } catch {
      ip = "unknown";
    }
    if (rateLimited(ip)) {
      return {
        state: "error",
        message: "That's a lot of submissions from one place. Please try again in a few minutes.",
      };
    }

    // ---- Validation -------------------------------------------------------
    const errors: Record<string, string> = {};
    if (!firstName) errors.firstName = "First name is required.";
    if (!lastName) errors.lastName = "Last name is required.";
    const emailLower = normalizeEmailLower(email);
    const phoneE164 = normalizePhoneE164(phone);
    if (email && !emailLower) errors.email = "That doesn't look like an email address.";
    if (phone && !phoneE164) errors.phone = "That doesn't look like a phone number.";
    if (!emailLower && !phoneE164) {
      errors.email = "Give us an email or a phone number — it is how we keep your record straight.";
      errors.phone = "Give us an email or a phone number — it is how we keep your record straight.";
    }
    const visitReport: VisitReport =
      visitReportRaw === "first_time" || visitReportRaw === "returning" || visitReportRaw === "unsure"
        ? visitReportRaw
        : "unsure";
    if (Object.keys(errors).length > 0) return { state: "invalid", errors };

    try {
      // Which church does an anonymous submission belong to? The MVP is one church,
      // so the answer is the only church; with more than one we refuse to guess
      // rather than write a person into the wrong tenant.
      const slug = process.env.PUBLIC_CHURCH_SLUG?.trim();
      const churches = slug
        ? await query<{ id: string; name: string }>(`select id, name from churches where slug = $1`, [slug])
        : await query<{ id: string; name: string }>(`select id, name from churches order by created_at asc`);
      if (churches.length === 0) {
        return {
          state: "setup-required",
          message: "No church exists in this database yet. A staff member needs to run the seed script.",
        };
      }
      if (churches.length > 1 && !slug) {
        return {
          state: "setup-required",
          message:
            "More than one church is in this database, so an anonymous card cannot be attributed. Set PUBLIC_CHURCH_SLUG to the church this site belongs to.",
        };
      }
      const churchId = churches[0].id;

      const payload: ConnectCardInput = {
        firstName,
        lastName,
        email: email || null,
        phone: phone || null,
        addressLine1: str(data.addressLine1, 200) || null,
        addressLine2: str(data.addressLine2, 200) || null,
        city: str(data.city, 120) || null,
        region: str(data.region, 60) || null,
        postalCode: str(data.postalCode, 20) || null,
        visitReport,
        children: str(data.children, 400) || null,
        householdMembers: str(data.householdMembers, 600) || null,
        howHeard: str(data.howHeard, 200) || null,
        prayerRequest: str(data.prayerRequest, 2000) || null,
        source: "connect_card",
        attendedAt: new Date(),
      };

      const result = await withTransaction(async (client) => resolveConnectCard(client, churchId, payload));

      return {
        state: "ok",
        fullName: result.fullName,
        visitNumber: result.visitNumber,
        isFirstVisit: result.isFirstVisit,
        isSecondVisit: result.isSecondVisit,
        personCreated: result.personCreated,
        matchedOn: result.matchedOn,
        nextStep: result.nextStep,
        currentStageName: result.currentStage?.name ?? null,
        reviewFlag: result.reviewFlag,
      };
    } catch (err) {
      if (err instanceof DbUnavailableError) return { state: "setup-required", message: err.message };
      const message = err instanceof Error ? err.message : "Something went wrong saving that.";
      return { state: "error", message };
    }
  });

/** Small helper the connect page uses to explain itself when there is no database. */
export const getConnectCardReadiness = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { DbUnavailableError, query } = await import("../lib/pg");
    const slug = process.env.PUBLIC_CHURCH_SLUG?.trim();
    const churches = slug
      ? await query<{ id: string; name: string }>(`select id, name from churches where slug = $1`, [slug])
      : await query<{ id: string; name: string }>(`select id, name from churches order by created_at asc`);
    if (churches.length === 0) {
      return {
        ready: false as const,
        message: "No church exists in this database yet. A staff member needs to run the seed script.",
      };
    }
    if (churches.length > 1 && !slug) {
      return {
        ready: false as const,
        message:
          "More than one church is in this database, so an anonymous card cannot be attributed. Set PUBLIC_CHURCH_SLUG to the church this site belongs to.",
      };
    }
    return { ready: true as const, churchName: churches[0].name };
  } catch (err) {
    return {
      ready: false as const,
      message:
        err instanceof Error
          ? err.message
          : "The database could not be read. A staff member should check the setup page.",
    };
  }
});
