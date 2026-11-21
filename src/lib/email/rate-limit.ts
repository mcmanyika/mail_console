import type { AdminClient } from "@/lib/supabase/admin";

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

export function getApiRateLimitPerMinute(): number {
  const n = Number.parseInt(process.env.API_RATE_LIMIT_PER_MINUTE ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? n : 60;
}

/**
 * Per-integration fixed-window limiter backed by `consume_api_rate_limit()`
 * (one atomic upsert — correct across serverless instances, unlike an
 * in-memory counter).
 *
 * If the limiter itself fails this THROWS; routes map that to 503 (fail closed).
 */
export async function consumeApiRateLimit(
  admin: AdminClient,
  integrationId: string,
  limit = getApiRateLimitPerMinute(),
  windowSeconds = 60,
): Promise<RateLimitResult> {
  const { data, error } = await admin.rpc("consume_api_rate_limit", {
    p_integration_id: integrationId,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) throw new Error(`rate limit check failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("rate limit check returned no data");
  return {
    allowed: Boolean(row.allowed),
    limit,
    remaining: Math.max(limit - Number(row.request_count), 0),
    retryAfterSeconds: Number(row.retry_after_seconds),
  };
}

export function rateLimitHeaders(r: RateLimitResult): Record<string, string> {
  const h: Record<string, string> = {
    "X-RateLimit-Limit": String(r.limit),
    "X-RateLimit-Remaining": String(r.remaining),
  };
  if (!r.allowed) h["Retry-After"] = String(r.retryAfterSeconds);
  return h;
}
