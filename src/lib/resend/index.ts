import { isDemoMode } from "@/lib/env";
import type { EmailAdapter } from "./adapter";
import { LiveEmailAdapter } from "./live";
import { MockEmailAdapter } from "./mock";

export type { EmailAdapter } from "./adapter";
export { ProviderRequestError, isRetryableStatus } from "./adapter";
export * from "./types";

/**
 * Returns the mock adapter when DEMO_MODE is on OR RESEND_API_KEY is missing
 * (so a half-configured environment can never send real mail by accident);
 * otherwise the live Resend adapter.
 */
export function resolveEmailAdapterMode(): "mock" | "live" {
  if (isDemoMode()) return "mock";
  if (!process.env.RESEND_API_KEY) return "mock";
  return "live";
}

let cached: EmailAdapter | undefined;
let cachedMode: "mock" | "live" | undefined;
let cachedLive: EmailAdapter | undefined;

function createLiveAdapter(): LiveEmailAdapter {
  return new LiveEmailAdapter({
    apiKey: process.env.RESEND_API_KEY as string,
    webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
  });
}

export function getEmailAdapter(): EmailAdapter {
  const mode = resolveEmailAdapterMode();
  if (cached && cachedMode === mode) return cached;
  cached = mode === "mock" ? new MockEmailAdapter() : createLiveAdapter();
  cachedMode = mode;
  return cached;
}

/**
 * Live Resend adapter when `RESEND_API_KEY` is set — even if DEMO_MODE forces
 * mock for sending. Used to refresh domain DNS status from the real provider.
 */
export function getLiveEmailAdapterIfConfigured(): EmailAdapter | null {
  if (!process.env.RESEND_API_KEY?.trim()) return null;
  if (resolveEmailAdapterMode() === "live") return getEmailAdapter();
  if (!cachedLive) cachedLive = createLiveAdapter();
  return cachedLive;
}

/** Test helper. */
export function resetEmailAdapterCache(): void {
  cached = undefined;
  cachedMode = undefined;
  cachedLive = undefined;
}

export const RESEND_PROVIDER = "resend";
export function getWebhookProviderAccount(): string {
  return process.env.RESEND_ACCOUNT_LABEL || "default";
}
