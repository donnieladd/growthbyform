// Presentation helpers for values that cross the server boundary as strings.
// Timestamps are formatted to 'YYYY-MM-DD"T"HH24:MI' in SQL, so nothing here deals
// with JS Date objects from the driver (React cannot render those anyway).

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDay(value: string | null | undefined): string {
  if (!value) return "—";
  const [date] = value.split("T");
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return value;
  return `${MONTHS[m - 1]} ${String(d)}`;
}

export function relativeDays(value: string | null | undefined): string {
  if (!value) return "never";
  const then = new Date(value.includes("T") ? value : `${value}T00:00`);
  if (Number.isNaN(then.getTime())) return value;
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${String(days)} days ago`;
  if (days < 60) return "about a month ago";
  return `${String(Math.round(days / 30))} months ago`;
}

export const SOURCE_LABELS: Record<string, string> = {
  connect_card: "connect card",
  kiosk: "kiosk",
  staff_entry: "staff entry",
  import: "import",
};

export function sourceLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return SOURCE_LABELS[value] ?? value;
}

export const CHECKPOINT_LABELS: Record<string, string> = {
  belonging: "Belonging (required, first)",
  self_understanding: "Self-understanding (required)",
  leadership_character: "Leadership / character (optional)",
  deployment: "Deployment (required, last)",
};

export function checkpointLabel(value: string | null): string | null {
  if (!value) return null;
  return CHECKPOINT_LABELS[value] ?? value;
}

/** "Sep 14, 15:00" — the timestamps arrive as 'YYYY-MM-DD"T"HH24:MI' from SQL. */
export function formatStamp(value: string | null | undefined): string {
  if (!value) return "—";
  const [date, time] = value.split("T");
  const day = formatDay(date);
  return time ? `${day}, ${time}` : day;
}

export const INTERACTION_KIND_LABELS: Record<string, string> = {
  call: "Call",
  text: "Text",
  email: "Email",
  in_person: "In person",
  note: "Note",
};

export function interactionLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return INTERACTION_KIND_LABELS[value] ?? value;
}

export const DECISION_LABELS: Record<string, string> = {
  salvation: "Salvation",
  rededication: "Rededication",
  baptism: "Baptism",
};

export function decisionLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return DECISION_LABELS[value] ?? value;
}

export const VISIT_REPORT_LABELS: Record<string, string> = {
  first_time: "told us it was their first time",
  returning: "told us they had been before",
  unsure: "was not sure if they had been before",
};

/** "12 days" / "1 day" / "today" — how long somebody has been in a stage. */
export function durationDays(days: number): string {
  if (days <= 0) return "today";
  return days === 1 ? "1 day" : `${String(days)} days`;
}

