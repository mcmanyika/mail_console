import { NextResponse } from "next/server";
import { safeEqualHex } from "@/lib/crypto/api-keys";
import { processOutboxBatch } from "@/lib/email/outbox";
import { reprocessWebhookEvents } from "@/lib/email/webhooks";
import { getOutboxConfig } from "@/lib/env";
import { getEmailAdapter } from "@/lib/resend";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 60;

const TIME_BUDGET_MS = 45_000;
const MAX_TICKS = 10;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed: an unset secret must never mean "open"
  const header = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m !== null && safeEqualHex(m[1], secret);
}

/**
 * Outbox worker tick. Vercel Cron invokes routes with GET and sends
 * `Authorization: Bearer $CRON_SECRET`; POST is accepted for other schedulers.
 *
 * Safe to run concurrently and to overlap: jobs are claimed with
 * FOR UPDATE SKIP LOCKED + leases, and the provider Idempotency-Key is stable
 * per job, so a double run cannot double-send.
 */
async function run(request: Request): Promise<Response> {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "cron_not_configured" }, { status: 503 });
  }
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const admin = createAdminClient();
  const adapter = getEmailAdapter();
  const batchSize = getOutboxConfig().batchSize;

  const totals = { ticks: 0, claimed: 0, succeeded: 0, retryScheduled: 0, failed: 0, dead: 0, skipped: 0 };
  try {
    while (totals.ticks < MAX_TICKS && Date.now() - started < TIME_BUDGET_MS) {
      const s = await processOutboxBatch(admin, adapter, { workerId: `cron-${started}-${totals.ticks}`, batchSize });
      totals.ticks++;
      totals.claimed += s.claimed;
      totals.succeeded += s.succeeded;
      totals.retryScheduled += s.retryScheduled;
      totals.failed += s.failed;
      totals.dead += s.dead;
      totals.skipped += s.skipped;
      if (s.claimed < batchSize) break; // queue drained
    }

    // Housekeeping that rides along: stuck webhook events + expired idempotency keys.
    const webhooks = await reprocessWebhookEvents(admin, adapter);
    await admin.from("api_idempotency_keys").delete().lt("expires_at", new Date().toISOString());

    return NextResponse.json({ ok: true, adapter: adapter.mode, outbox: totals, webhooks, ms: Date.now() - started });
  } catch (err) {
    console.error("[cron/outbox] failed", err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: false, error: "worker_failed", outbox: totals }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
