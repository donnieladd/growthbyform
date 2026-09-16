// Cookie/session constants with no server-only imports, so both the server-fn
// modules (which are imported by routes, and therefore reach the client bundle)
// and the server-only implementations can share them.

export const SESSION_COOKIE = "gt_session";
export const SESSION_TTL_DAYS = 30;
export const MIN_PASSWORD_LENGTH = 10;
