/**
 * Centralised, validated access to environment variables.
 *
 * NOTE: `NEXT_PUBLIC_*` variables MUST be referenced as literal
 * `process.env.NEXT_PUBLIC_X` expressions so Next.js can inline them into the
 * browser bundle — do not read them through a dynamic key.
 */

export class MissingEnvError extends Error {
  constructor(name: string) {
    super(`Missing required environment variable: ${name}`);
    this.name = "MissingEnvError";
  }
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new MissingEnvError(name);
  return value;
}

/** Public (browser-safe) Supabase config. */
export function getSupabasePublicConfig(): { url: string; anonKey: string } {
  return {
    url: required("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL),
    anonKey: required("NEXT_PUBLIC_SUPABASE_ANON_KEY", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  };
}

export function hasSupabasePublicConfig(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

/** SERVER ONLY. */
export function getSupabaseServiceRoleKey(): string {
  return required("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function getAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

/** DEMO_MODE=true forces the mock email adapter: nothing is ever really sent. */
export function isDemoMode(): boolean {
  const v = process.env.DEMO_MODE?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function intFromEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function getOutboxConfig() {
  return {
    batchSize: intFromEnv("OUTBOX_BATCH_SIZE", 10),
    maxAttempts: intFromEnv("OUTBOX_MAX_ATTEMPTS", 6),
    leaseSeconds: intFromEnv("OUTBOX_LEASE_SECONDS", 120, 10),
  };
}

export function getMaxAttachmentBytes(): number {
  return intFromEnv("MAX_ATTACHMENT_BYTES", 25 * 1024 * 1024);
}
