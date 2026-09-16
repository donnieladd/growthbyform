// Normalized match keys. Identity resolution is the whole point of capture, so
// every intake channel (connect card, kiosk, staff entry, import) must derive its
// keys with the SAME functions, or the same human becomes two records forever.
//
// These are deliberately pure and dependency-free so the server, the migration
// seed and any future import job can all call them.

/**
 * Normalize a phone number to E.164. Assumes +1 for bare 10/11-digit numbers
 * (the default for the pilot church); override DEFAULT_PHONE_COUNTRY when a second
 * country shows up. Returns null when there is nothing trustworthy to match on —
 * a bad key is worse than no key, because it creates duplicates.
 */
export function normalizePhoneE164(
  raw: string | null | undefined,
  defaultCountry = process.env.DEFAULT_PHONE_COUNTRY?.trim() || "US",
): string | null {
  if (!raw) return null;
  const stripped = raw.trim();
  if (!stripped) return null;
  const hasPlus = stripped.startsWith("+");
  const digits = stripped.replace(/\D/g, "");
  if (!digits) return null;
  if (hasPlus) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (defaultCountry === "US") {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  }
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

/** Lowercased, trimmed email, or null if it does not look like an email. */
export function normalizeEmailLower(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  // One @, something either side, a dot after the @, no whitespace.
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(trimmed)) return null;
  if (trimmed.length > 254) return null;
  return trimmed;
}

/**
 * Normalize a person's name for matching: strip accents and punctuation, lowercase,
 * collapse whitespace. Order is preserved (first then last) because "Alvarez, Maria"
 * and "Maria Alvarez" normalize to the same key only if the caller is consistent.
 */
export function normalizeName(first: string | null | undefined, last?: string | null): string {
  return [first ?? "", last ?? ""]
    .map((part) => part.normalize("NFKD").replace(/[\u0300-\u036f]/g, ""))
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const STREET_ABBREVIATIONS: Record<string, string> = {
  st: "street",
  str: "street",
  ave: "avenue",
  av: "avenue",
  rd: "road",
  blvd: "boulevard",
  dr: "drive",
  ln: "lane",
  ct: "court",
  cir: "circle",
  pl: "place",
  pkwy: "parkway",
  hwy: "highway",
  n: "north",
  s: "south",
  e: "east",
  w: "west",
  ne: "northeast",
  nw: "northwest",
  se: "southeast",
  sw: "southwest",
  apt: "apartment",
  ste: "suite",
  unit: "unit",
  bldg: "building",
  fl: "floor",
};

/**
 * Normalize a postal address for matching: expand common abbreviations, drop
 * punctuation, lowercase, collapse whitespace. House-number + street + city +
 * postal code is what actually distinguishes two families with the same name.
 */
export function normalizeAddress(parts: {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
}): string | null {
  const flatten = (value?: string | null) =>
    (value ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");

  const expanded = (value?: string | null) =>
    flatten(value)
      .split(" ")
      .filter(Boolean)
      .map((word) => STREET_ABBREVIATIONS[word] ?? word)
      .join(" ");

  const line1 = expanded(parts.addressLine1);
  const line2 = expanded(parts.addressLine2);
  const city = flatten(parts.city);
  const region = flatten(parts.region);
  const postal = flatten(parts.postalCode).replace(/\s+/g, "").slice(0, 5);

  const joined = [line1, line2, city, region, postal].filter(Boolean).join(" ");
  return joined.length > 0 ? joined : null;
}

/** A stable filename-ish slug, used for household display names. */
export function householdName(lastName: string): string {
  const trimmed = lastName.trim();
  if (!trimmed) return "Household";
  const plural = /s$/i.test(trimmed) ? `${trimmed}'` : `${trimmed}s`;
  return `The ${plural} Household`;
}

export function titleCase(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((word) => (word.length <= 2 ? word : word[0].toUpperCase() + word.slice(1)))
    .join(" ");
}
