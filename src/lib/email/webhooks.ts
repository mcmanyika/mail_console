import { isDemoMode } from "@/lib/env";
import type { EmailAdapter } from "@/lib/resend/adapter";
import { syncDomainFromProvider } from "@/lib/resend/domains";
import { MockEmailAdapter } from "@/lib/resend/mock";
import { WebhookVerificationError, type ProviderWebhookEvent } from "@/lib/resend/types";
import { verifySvixWebhook } from "@/lib/resend/webhook-verify";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json, WebhookEventRow } from "@/lib/types/database";
import { applyDeliveryEvent, isDeliveryEvent } from "./delivery";
import { processInboundEmailEvent } from "./inbound";

/**
 * Resend webhook pipeline:
 *
 *   verify signature (RAW body)  ->  durable intake (webhook_events, unique per
 *   provider+account+event_id)   ->  200/ack is only possible after the row is
 *   committed                    ->  claim (optimistic lease) -> process -> mark
 *
 * Failure handling: a processing failure marks the row `failed` and answers
 * 500 so Resend redelivers (same event id => same row => no duplicate effects);
 * the cron route also retries `failed`/stale rows, up to MAX_ATTEMPTS.
 */

export const MAX_WEBHOOK_ATTEMPTS = 5;
export const WEBHOOK_LEASE_SECONDS = 300;
export const MAX_WEBHOOK_BODY_BYTES = 1_000_000;
export const DEMO_HEADER = "x-mail-console-demo";

export type WebhookHttpResult = { status: number; body: Record<string, unknown> };

type ProcessOutcome = { status: "processed" | "ignored"; note?: string } | { status: "retry"; note: string };

// ---- verification ----------------------------------------------------------------------------
/**
 * Live: Svix signature required (RESEND_WEBHOOK_SECRET).
 * Demo: only when DEMO_MODE=true AND the request carries `X-Mail-Console-Demo: 1`
 * may an unsigned fixture be accepted. The header is ignored outside demo mode.
 */
export function verifyIncomingWebhook(
  rawBody: string,
  headers: Headers,
): { event: ProviderWebhookEvent; demo: boolean } {
  if (isDemoMode() && headers.get(DEMO_HEADER) === "1") {
    return { event: new MockEmailAdapter().verifyWebhook(rawBody, headers), demo: true };
  }
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) throw new WebhookConfigError();
  return { event: verifySvixWebhook(rawBody, headers, secret), demo: false };
}

export class WebhookConfigError extends Error {
  constructor() {
    super("RESEND_WEBHOOK_SECRET is not configured");
    this.name = "WebhookConfigError";
  }
}

// ---- intake / claim ----------------------------------------------------------------------------
export async function recordWebhookEvent(
  admin: AdminClient,
  params: { provider: string; account: string; event: ProviderWebhookEvent },
): Promise<{ row: WebhookEventRow; duplicate: boolean }> {
  const { provider, account, event } = params;
  const { data, error } = await admin
    .from("webhook_events")
    .insert({
      provider,
      provider_account: account,
      event_id: event.eventId,
      event_type: event.type,
      payload: event.raw as Json,
    })
    .select("*")
    .single();
  if (!error && data) return { row: data, duplicate: false };

  if (error?.code === "23505") {
    const { data: existing, error: selErr } = await admin
      .from("webhook_events")
      .select("*")
      .eq("provider", provider)
      .eq("provider_account", account)
      .eq("event_id", event.eventId)
      .single();
    if (selErr || !existing) throw new Error(`webhook intake conflict but row missing: ${selErr?.message ?? "no row"}`);
    return { row: existing, duplicate: true };
  }
  throw new Error(`webhook intake failed: ${error?.message ?? "no data"}`);
}

function isClaimable(row: WebhookEventRow, now: Date): boolean {
  if (row.status === "received" || row.status === "failed") return row.attempts < MAX_WEBHOOK_ATTEMPTS;
  if (row.status === "processing") {
    const lockedAt = row.locked_at ? Date.parse(row.locked_at) : 0;
    return now.getTime() - lockedAt > WEBHOOK_LEASE_SECONDS * 1000 && row.attempts < MAX_WEBHOOK_ATTEMPTS;
  }
  return false; // processed / ignored: done
}

/** Optimistic claim: only one concurrent caller can move `attempts` from N to N+1. */
async function claimWebhookEvent(admin: AdminClient, row: WebhookEventRow, now = new Date()): Promise<WebhookEventRow | null> {
  if (!isClaimable(row, now)) return null;
  const { data, error } = await admin
    .from("webhook_events")
    .update({ status: "processing", locked_at: now.toISOString(), attempts: row.attempts + 1 })
    .eq("id", row.id)
    .eq("attempts", row.attempts)
    .in("status", ["received", "failed", "processing"])
    .select("*");
  if (error) throw new Error(`webhook claim failed: ${error.message}`);
  return data?.[0] ?? null;
}

async function finishWebhookEvent(
  admin: AdminClient,
  id: string,
  status: "processed" | "ignored" | "failed",
  error: string | null,
) {
  const { error: upErr } = await admin
    .from("webhook_events")
    .update({ status, error: error?.slice(0, 1000) ?? null, processed_at: new Date().toISOString(), locked_at: null })
    .eq("id", id);
  if (upErr) throw new Error(`failed to finalise webhook event: ${upErr.message}`);
}

// ---- dispatch -----------------------------------------------------------------------------------
async function dispatchEvent(
  admin: AdminClient,
  adapter: EmailAdapter,
  event: ProviderWebhookEvent,
  attempts: number,
  opts: { allowInlineContent: boolean },
): Promise<ProcessOutcome> {
  if (event.type === "email.received") {
    const result = await processInboundEmailEvent(admin, adapter, event, { allowInlineContent: opts.allowInlineContent });
    if (result.outcome === "unmatched") {
      // Kept for ops review (webhook_events has no client-facing RLS policy).
      return { status: "ignored", note: `unmatched: ${result.reason}` };
    }
    return { status: "processed", note: result.warnings.length ? result.warnings.join("; ") : undefined };
  }

  if (isDeliveryEvent(event.type)) {
    const result = await applyDeliveryEvent(admin, event);
    if (result.outcome === "message_not_found") {
      // Could be an out-of-order event that beat our own bookkeeping; retry a few times, then park it.
      return attempts < MAX_WEBHOOK_ATTEMPTS
        ? { status: "retry", note: "message_not_found" }
        : { status: "ignored", note: "unmatched: message_not_found" };
    }
    return { status: "processed", note: result.outcome === "noop" ? "no state change (duplicate or older)" : undefined };
  }

  if (event.type.startsWith("domain.")) {
    const id = typeof event.data.id === "string" ? event.data.id : typeof event.data.domain_id === "string" ? event.data.domain_id : null;
    if (!id) return { status: "ignored", note: "domain event without id" };
    if (event.type === "domain.deleted") return { status: "ignored", note: "domain.deleted not mirrored" };
    const outcome = await syncDomainFromProvider(admin, adapter, id);
    return outcome === "updated" ? { status: "processed" } : { status: "ignored", note: "unmatched: unknown domain" };
  }

  return { status: "ignored", note: `unsupported event type: ${event.type}` };
}

/** Claim + process + mark. Returns the final HTTP-relevant disposition. */
export async function processWebhookRow(
  admin: AdminClient,
  adapter: EmailAdapter,
  row: WebhookEventRow,
  opts: { allowInlineContent: boolean },
): Promise<"processed" | "ignored" | "failed" | "not_claimed"> {
  const claimed = await claimWebhookEvent(admin, row);
  if (!claimed) return "not_claimed";

  const payload = (claimed.payload ?? {}) as Record<string, unknown>;
  const event: ProviderWebhookEvent = {
    eventId: claimed.event_id,
    type: claimed.event_type,
    createdAt: typeof payload.created_at === "string" ? payload.created_at : claimed.received_at,
    data: (payload.data && typeof payload.data === "object" ? payload.data : {}) as Record<string, unknown>,
    raw: payload,
  };

  try {
    const outcome = await dispatchEvent(admin, adapter, event, claimed.attempts, opts);
    if (outcome.status === "retry") {
      await finishWebhookEvent(admin, claimed.id, "failed", outcome.note);
      return "failed";
    }
    await finishWebhookEvent(admin, claimed.id, outcome.status, outcome.note ?? null);
    return outcome.status;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishWebhookEvent(admin, claimed.id, "failed", message);
    return "failed";
  }
}

// ---- HTTP entry --------------------------------------------------------------------------------------
export async function handleResendWebhook(params: {
  admin: AdminClient;
  adapter: EmailAdapter;
  rawBody: string;
  headers: Headers;
  provider: string;
  account: string;
}): Promise<WebhookHttpResult> {
  const { admin, adapter, rawBody, headers } = params;

  if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BODY_BYTES) {
    return { status: 413, body: { error: "payload_too_large" } };
  }

  let verified: { event: ProviderWebhookEvent; demo: boolean };
  try {
    verified = verifyIncomingWebhook(rawBody, headers);
  } catch (err) {
    if (err instanceof WebhookConfigError) return { status: 503, body: { error: "webhook_not_configured" } };
    if (err instanceof WebhookVerificationError) return { status: 400, body: { error: "invalid_signature" } };
    throw err;
  }

  // 1. Durable intake. Nothing is acknowledged before this row is committed.
  const { row, duplicate } = await recordWebhookEvent(admin, {
    provider: params.provider,
    account: params.account,
    event: verified.event,
  });

  if (row.status === "processed" || row.status === "ignored") {
    return { status: 200, body: { ok: true, duplicate: true, status: row.status } };
  }

  // 2. Process. Failures answer 500 so the provider redelivers (until MAX attempts).
  const disposition = await processWebhookRow(admin, adapter, row, { allowInlineContent: verified.demo });
  switch (disposition) {
    case "processed":
    case "ignored":
      return { status: 200, body: { ok: true, duplicate, status: disposition } };
    case "not_claimed":
      // Another worker holds the lease, or attempts are exhausted (row stays for ops review).
      return { status: 200, body: { ok: true, duplicate, status: row.attempts >= MAX_WEBHOOK_ATTEMPTS ? "failed_permanently" : "in_progress" } };
    case "failed": {
      const { data } = await admin.from("webhook_events").select("attempts").eq("id", row.id).maybeSingle();
      const exhausted = (data?.attempts ?? 0) >= MAX_WEBHOOK_ATTEMPTS;
      return exhausted
        ? { status: 200, body: { ok: true, duplicate, status: "failed_permanently" } }
        : { status: 500, body: { error: "processing_failed", retry: true } };
    }
  }
}

// ---- cron reprocessing ---------------------------------------------------------------------------------
/** Retries events that were durably recorded but never finished (crash, provider outage, race). */
export async function reprocessWebhookEvents(
  admin: AdminClient,
  adapter: EmailAdapter,
  opts: { limit?: number; now?: Date } = {},
): Promise<{ examined: number; processed: number; ignored: number; failed: number; skipped: number }> {
  const limit = opts.limit ?? 20;
  const now = opts.now ?? new Date();
  const settleBefore = new Date(now.getTime() - 120_000).toISOString();
  const staleLockBefore = new Date(now.getTime() - WEBHOOK_LEASE_SECONDS * 1000).toISOString();

  const { data: pending, error } = await admin
    .from("webhook_events")
    .select("*")
    .in("status", ["received", "failed"])
    .lt("attempts", MAX_WEBHOOK_ATTEMPTS)
    .lt("received_at", settleBefore)
    .order("received_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`webhook reprocess query failed: ${error.message}`);
  const { data: stale, error: staleErr } = await admin
    .from("webhook_events")
    .select("*")
    .eq("status", "processing")
    .lt("locked_at", staleLockBefore)
    .lt("attempts", MAX_WEBHOOK_ATTEMPTS)
    .limit(limit);
  if (staleErr) throw new Error(`webhook reprocess query failed: ${staleErr.message}`);

  const rows = [...(pending ?? []), ...(stale ?? [])].slice(0, limit);
  const summary = { examined: rows.length, processed: 0, ignored: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    const r = await processWebhookRow(admin, adapter, row, { allowInlineContent: isDemoMode() });
    if (r === "processed") summary.processed++;
    else if (r === "ignored") summary.ignored++;
    else if (r === "failed") summary.failed++;
    else summary.skipped++;
  }
  return summary;
}
