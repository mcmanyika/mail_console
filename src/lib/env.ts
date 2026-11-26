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

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}

function isLocalHost(urlOrHost: string): boolean {
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(urlOrHost);
}

/**
 * Canonical public origin for invite links, auth redirects, etc.
 * Prefer NEXT_PUBLIC_APP_URL; in production ignore a localhost value and fall
 * back to Vercel’s production/deployment host so invites never point at :3000.
 */
export function getAppUrl(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured && !(isProduction() && isLocalHost(configured))) {
    return stripTrailingSlash(configured);
  }
  const vercelHost = (process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL)?.trim();
  if (vercelHost) {
    const host = vercelHost.replace(/^https?:\/\//, "");
    return `https://${host}`;
  }
  return stripTrailingSlash(configured || "http://localhost:3000");
}

/**
 * Prefer the incoming request’s public origin (so invites match the domain the
 * admin is actually using, e.g. https://www.mailconsole.app). Falls back to getAppUrl().
 */
export async function getRequestAppUrl(): Promise<string> {
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    const origin = h.get("origin");
    if (origin && !isLocalHost(origin)) return stripTrailingSlash(origin);
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (host && !isLocalHost(host)) {
      const proto = h.get("x-forwarded-proto") ?? (isProduction() ? "https" : "http");
      return `${proto}://${host.split(",")[0]!.trim()}`;
    }
  } catch {
    // Not in a request context (tests, scripts).
  }
  return getAppUrl();
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

/** SERVER ONLY. OpenAI chat for inbox assist. Missing key disables AI features. */
export function isOpenAiConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export function getOpenAiConfig(): { apiKey: string; model: string } {
  return {
    apiKey: required("OPENAI_API_KEY", process.env.OPENAI_API_KEY?.trim()),
    model: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
  };
}

/** SERVER ONLY. Stripe billing — Checkout + webhooks. */
export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim() && process.env.STRIPE_WEBHOOK_SECRET?.trim());
}

export function getStripeConfig(): {
  secretKey: string;
  webhookSecret: string;
  publishableKey: string | null;
  priceIds: { starter: string | null; growth: string | null; scale: string | null };
} {
  return {
    secretKey: required("STRIPE_SECRET_KEY", process.env.STRIPE_SECRET_KEY?.trim()),
    webhookSecret: required("STRIPE_WEBHOOK_SECRET", process.env.STRIPE_WEBHOOK_SECRET?.trim()),
    publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim() || null,
    priceIds: {
      starter: process.env.STRIPE_PRICE_STARTER?.trim() || null,
      growth: process.env.STRIPE_PRICE_GROWTH?.trim() || null,
      scale: process.env.STRIPE_PRICE_SCALE?.trim() || null,
    },
  };
}
