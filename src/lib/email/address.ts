/**
 * Email address helpers. Deliberately conservative: we only accept plain
 * `local@host` addresses (no quoted locals, no comments) because anything
 * exotic is far more likely to be an injection attempt than a real mailbox.
 */

const ADDRESS_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function hasControlChars(value: string): boolean {
  return CONTROL_CHARS.test(value);
}

export function isValidEmailAddress(address: string): boolean {
  return address.length <= 254 && ADDRESS_RE.test(address);
}

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Pulls the bare address out of `"Name" <a@b.example>` / `a@b.example`.
 * Returns null when no valid address can be extracted.
 */
export function extractAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const angle = /<([^<>]+)>\s*$/.exec(value.trim());
  const candidate = normalizeAddress(angle ? angle[1] : value);
  return isValidEmailAddress(candidate) ? candidate : null;
}

/** Splits a comma separated header (naively, respecting quotes/angle brackets). */
export function splitAddressList(header: string | null | undefined): string[] {
  if (!header) return [];
  const out: string[] = [];
  let depthAngle = 0;
  let inQuote = false;
  let cur = "";
  for (const ch of header) {
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === "<") depthAngle++;
    else if (!inQuote && ch === ">") depthAngle = Math.max(depthAngle - 1, 0);
    if (ch === "," && !inQuote && depthAngle === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Unique, valid, lower-cased bare addresses from a list of header values / addresses. */
export function extractAddresses(values: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const v of values) {
    for (const part of splitAddressList(v)) {
      const a = extractAddress(part);
      if (a) seen.add(a);
    }
  }
  return [...seen];
}

/** `"Display Name" <addr>`; strips anything that could break out of the header. */
export function formatFromHeader(displayName: string | null | undefined, address: string): string {
  const name = (displayName ?? "")
    .replace(CONTROL_CHARS, " ")
    .replace(/["\\<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return name ? `"${name}" <${address}>` : address;
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** Strips a `+tag` sub-address: `support+billing@x.example` -> `support@x.example`. */
export function stripPlusTag(address: string): string {
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at);
  const plus = local.indexOf("+");
  return plus > 0 ? `${local.slice(0, plus)}${address.slice(at)}` : address;
}
