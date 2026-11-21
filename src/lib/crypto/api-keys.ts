import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { customAlphabet } from "nanoid";
import { isProduction } from "@/lib/env";

/**
 * API keys look like:   mck_<8-char prefix>_<43-char secret>
 *   - the prefix is stored in clear (`app_integrations.key_prefix` = "mck_<prefix>")
 *     and lets us look a key up without scanning hashes;
 *   - the secret is 256 bits of CSPRNG output, shown to the user exactly once;
 *   - only HMAC-SHA256(key, pepper) is stored. Keys are high-entropy random
 *     strings, so a fast keyed hash is appropriate (no need for bcrypt/argon2).
 *
 * The same primitives hash single-use invitation tokens.
 */

export const API_KEY_PREFIX = "mck";
const PREFIX_LENGTH = 8;
const prefixAlphabet = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", PREFIX_LENGTH);

const API_KEY_REGEX = /^mck_([a-z0-9]{8})_([A-Za-z0-9_-]{20,128})$/;
const DEV_PEPPER = "mail-console-dev-pepper"; // must match supabase/seed.sql

export type GeneratedApiKey = {
  /** Full key — show once, never store or log. */
  key: string;
  /** Value for `app_integrations.key_prefix`, e.g. "mck_ab12cd34". Safe to display. */
  keyPrefix: string;
  /** Value for `app_integrations.key_hash`. */
  keyHash: string;
};

function getPepper(): string {
  const pepper = process.env.API_KEY_PEPPER;
  if (pepper && pepper.length >= 16) return pepper;
  if (isProduction()) {
    throw new Error("API_KEY_PEPPER must be set (>= 16 chars) in production");
  }
  return DEV_PEPPER;
}

/** HMAC-SHA256 (hex) of a secret value with the server-side pepper. */
export function hashSecret(value: string): string {
  return createHmac("sha256", getPepper()).update(value, "utf8").digest("hex");
}

export function hashApiKey(key: string): string {
  return hashSecret(key);
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = prefixAlphabet();
  const secret = randomBytes(32).toString("base64url"); // 43 chars
  const key = `${API_KEY_PREFIX}_${prefix}_${secret}`;
  return { key, keyPrefix: `${API_KEY_PREFIX}_${prefix}`, keyHash: hashApiKey(key) };
}

/** Extracts the lookup prefix ("mck_xxxxxxxx") from a presented key, or null if malformed. */
export function parseApiKey(key: string): { keyPrefix: string } | null {
  const m = API_KEY_REGEX.exec(key.trim());
  return m ? { keyPrefix: `${API_KEY_PREFIX}_${m[1]}` } : null;
}

/** Constant-time comparison of a presented key against a stored hash. */
export function verifyApiKey(presentedKey: string, storedHash: string): boolean {
  return safeEqualHex(hashApiKey(presentedKey), storedHash);
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Pulls the key out of an `Authorization: Bearer <key>` header. */
export function extractBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

/** Single-use invitation token (URL-safe) and its hash. */
export function generateInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashSecret(token) };
}

export function hashInviteToken(token: string): string {
  return hashSecret(token);
}

/** Plain SHA-256 hex (for request-body fingerprints, not for secrets). */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
