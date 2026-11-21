import { format, formatDistanceToNowStrict, isThisYear, isToday } from "date-fns";

/** Parse `"Name <addr@host>"` or a bare address. */
export function parseAddress(raw: string | null | undefined): { name: string | null; email: string } {
  const value = (raw ?? "").trim();
  const m = /^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/.exec(value);
  if (m) {
    const name = m[1].trim();
    return { name: name || null, email: m[2].trim().toLowerCase() };
  }
  return { name: null, email: value.toLowerCase() };
}

export function displayName(raw: string | null | undefined): string {
  const p = parseAddress(raw);
  return p.name ?? p.email;
}

export function initials(raw: string | null | undefined): string {
  const label = displayName(raw).replace(/@.*/, "");
  const parts = label.split(/[\s._-]+/).filter(Boolean);
  const chars = parts.length > 1 ? parts[0][0] + parts[1][0] : label.slice(0, 2);
  return (chars || "?").toUpperCase();
}

/** List timestamps: time today, "Nov 18" this year, otherwise with year. */
export function formatListDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isToday(d)) return format(d, "h:mm a");
  if (isThisYear(d)) return format(d, "MMM d");
  return format(d, "MMM d, yyyy");
}

export function formatFullDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return format(new Date(iso), "EEE, MMM d, yyyy 'at' h:mm a");
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "never";
  return `${formatDistanceToNowStrict(new Date(iso))} ago`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

export function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(100, Math.round((part / whole) * 100));
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]{2,}$/;
export function isEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}

/** Splits a free-form recipients string into unique, lower-cased addresses; reports invalid tokens. */
export function parseRecipients(input: string | null | undefined): { valid: string[]; invalid: string[] } {
  const tokens = (input ?? "")
    .split(/[,;\n]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const token of tokens) {
    const email = parseAddress(token).email;
    if (isEmail(email)) {
      if (!valid.includes(email)) valid.push(email);
    } else invalid.push(token);
  }
  return { valid, invalid };
}

export function monthLabel(yearMonth: string): string {
  const match = /^(\d{4})-(\d{1,2})$/.exec(yearMonth.trim());
  if (!match) return yearMonth || "—";
  const y = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return yearMonth;
  return format(new Date(Date.UTC(y, m - 1, 1)), "MMM");
}

/** The last `count` year-months (UTC), oldest first. */
export function lastYearMonths(count: number, from: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

export function startOfMonthIso(date: Date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();
}

/** PostgREST `or()`/`ilike` values choke on these characters; strip rather than escape. */
export function sanitizeSearch(q: string | null | undefined): string {
  return (q ?? "").replace(/[%*,()\\:"']/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

export function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Supabase embeds are typed as arrays for non-1:1 relations but arrive as objects at runtime. */
export function one<T>(value: T | T[] | null | undefined): T | null {
  if (value == null) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}
