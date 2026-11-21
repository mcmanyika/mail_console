import { nanoid } from "nanoid";
import { getOutboxConfig } from "@/lib/env";
import type { EmailAdapter } from "@/lib/resend/adapter";
import type { OutboundAttachment, ProviderError, SendEmailInput } from "@/lib/resend/types";
import type { AdminClient } from "@/lib/supabase/admin";
import type { MessageRecipientRow, MessageRow, OutboxJobRow } from "@/lib/types/database";
import { MAX_RECIPIENTS_PER_MESSAGE, countQuotaUnits, currentYearMonth, finalizeJobQuota } from "./quota";

/**
 * Transactional outbox for outbound mail.
 *
 *   enqueueOutboundMessage()   draft -> outbound/queued + job + quota reservation (one SQL txn)
 *   processOutbox()            claim due jobs (SKIP LOCKED) -> send via adapter -> record result
 *
 * Delivery semantics are at-least-once with provider-side idempotency
 * (`mc-outbox-<job id>` is sent as the Idempotency-Key on every attempt), so a
 * crash between "provider accepted" and "we recorded it" cannot double-send.
 */

// ---- enqueue ------------------------------------------------------------------
export type EnqueueResult =
  | { status: "queued" | "already_queued"; jobId: string; threadId: string; messageId: string }
  | { status: "quota_exceeded"; reserved: number; settled: number; limit: number }
  | { status: "workspace_inactive" }
  | { status: "invalid"; reason: string };

export async function enqueueOutboundMessage(
  admin: AdminClient,
  params: {
    messageId: string;
    /** Caller-chosen key; same key => same job (safe to retry the request). */
    idempotencyKey: string;
    recipients: { to?: string[]; cc?: string[]; bcc?: string[] };
    rfcMessageId?: string | null;
    inReplyTo?: string | null;
    references?: string | null;
    now?: Date;
  },
): Promise<EnqueueResult> {
  const units = countQuotaUnits(params.recipients);
  if (units < 1) return { status: "invalid", reason: "at least one recipient is required" };
  if (units > MAX_RECIPIENTS_PER_MESSAGE) {
    return { status: "invalid", reason: `at most ${MAX_RECIPIENTS_PER_MESSAGE} recipients per message` };
  }

  const { data, error } = await admin.rpc("enqueue_outbound_message", {
    p_message_id: params.messageId,
    p_idempotency_key: params.idempotencyKey,
    p_year_month: currentYearMonth(params.now),
    p_units: units,
    p_rfc_message_id: params.rfcMessageId ?? null,
    p_in_reply_to: params.inReplyTo ?? null,
    p_references: params.references ?? null,
  });
  if (error) throw new Error(`enqueue_outbound_message failed: ${error.message}`);

  const r = data as Record<string, unknown> | null;
  switch (r?.status) {
    case "queued":
    case "already_queued":
      return {
        status: r.status,
        jobId: String(r.job_id),
        threadId: String(r.thread_id),
        messageId: String(r.message_id),
      };
    case "quota_exceeded":
      return {
        status: "quota_exceeded",
        reserved: Number(r.reserved),
        settled: Number(r.settled),
        limit: Number(r.limit),
      };
    case "workspace_inactive":
      return { status: "workspace_inactive" };
    default:
      throw new Error("unexpected enqueue_outbound_message response");
  }
}

// ---- retry policy ---------------------------------------------------------------
/** Exponential backoff: 15s, 30s, 1m, 2m, 4m ... capped at 1h, with up to +20% jitter. */
export function computeBackoffSeconds(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(15 * 2 ** Math.max(attempts - 1, 0), 3600);
  return Math.round(base * (1 + random() * 0.2));
}

export type FailureDecision = { action: "retry"; delaySeconds: number } | { action: "dead" } | { action: "failed" };

/** `attempts` is the number of attempts INCLUDING the one that just failed. */
export function decideFailure(
  error: Pick<ProviderError, "retryable">,
  attempts: number,
  maxAttempts: number,
  random: () => number = Math.random,
): FailureDecision {
  if (!error.retryable) return { action: "failed" };
  if (attempts >= maxAttempts) return { action: "dead" };
  return { action: "retry", delaySeconds: computeBackoffSeconds(attempts, random) };
}

// ---- processing -----------------------------------------------------------------
export type JobOutcome = "succeeded" | "retry_scheduled" | "failed" | "dead" | "skipped";

export type ProcessSummary = {
  claimed: number;
  succeeded: number;
  retryScheduled: number;
  failed: number;
  dead: number;
  skipped: number;
};

export function buildSendInput(
  message: Pick<MessageRow, "from_address" | "reply_to" | "subject" | "text_body" | "html_body" | "rfc_message_id" | "in_reply_to" | "references_header">,
  recipients: Pick<MessageRecipientRow, "address" | "type">[],
  attachments: OutboundAttachment[] = [],
): SendEmailInput {
  const byType = (t: "to" | "cc" | "bcc") => recipients.filter((r) => r.type === t).map((r) => r.address);
  const headers: Record<string, string> = {};
  if (message.rfc_message_id) headers["Message-ID"] = message.rfc_message_id;
  if (message.in_reply_to) headers["In-Reply-To"] = message.in_reply_to;
  if (message.references_header) headers["References"] = message.references_header;

  return {
    from: message.from_address,
    to: byType("to"),
    cc: byType("cc"),
    bcc: byType("bcc"),
    replyTo: message.reply_to ? [message.reply_to] : undefined,
    subject: message.subject,
    text: message.text_body ?? undefined,
    html: message.html_body ?? undefined,
    headers: Object.keys(headers).length ? headers : undefined,
    attachments: attachments.length ? attachments : undefined,
  };
}

export async function claimOutboxJobs(admin: AdminClient, workerId: string, batchSize?: number): Promise<OutboxJobRow[]> {
  const cfg = getOutboxConfig();
  const { data, error } = await admin.rpc("claim_outbox_jobs", {
    p_worker_id: workerId,
    p_batch_size: batchSize ?? cfg.batchSize,
    p_lease_seconds: cfg.leaseSeconds,
  });
  if (error) throw new Error(`claim_outbox_jobs failed: ${error.message}`);
  return (data ?? []) as OutboxJobRow[];
}

async function loadAttachments(admin: AdminClient, messageId: string): Promise<OutboundAttachment[]> {
  const { data, error } = await admin
    .from("attachments")
    .select("storage_path, filename, mime_type, content_id")
    .eq("message_id", messageId);
  if (error) throw new Error(`failed to load attachments: ${error.message}`);

  const out: OutboundAttachment[] = [];
  for (const a of data ?? []) {
    const { data: blob, error: dlErr } = await admin.storage.from("attachments").download(a.storage_path);
    if (dlErr || !blob) throw new Error(`failed to download attachment ${a.filename}: ${dlErr?.message ?? "empty"}`);
    out.push({
      filename: a.filename,
      contentType: a.mime_type,
      content: new Uint8Array(await blob.arrayBuffer()),
      contentId: a.content_id ?? undefined,
    });
  }
  return out;
}

async function markJobFailure(
  admin: AdminClient,
  job: OutboxJobRow,
  message: Pick<MessageRow, "id">,
  error: ProviderError,
  decision: FailureDecision,
): Promise<JobOutcome> {
  if (decision.action === "retry") {
    const next = new Date(Date.now() + decision.delaySeconds * 1000).toISOString();
    const { error: upErr } = await admin
      .from("outbox_jobs")
      .update({ status: "pending", next_attempt_at: next, last_error: error.message.slice(0, 1000), claimed_at: null, claimed_by: null })
      .eq("id", job.id);
    if (upErr) throw new Error(`failed to schedule retry: ${upErr.message}`);
    return "retry_scheduled";
  }

  // Terminal: record on the job, fail the message + recipients, release quota.
  const status = decision.action; // 'failed' | 'dead'
  await admin
    .from("outbox_jobs")
    .update({ status, last_error: error.message.slice(0, 1000), claimed_at: null, claimed_by: null })
    .eq("id", job.id);
  await admin
    .from("messages")
    .update({ lifecycle_state: "failed", failure_reason: error.message.slice(0, 1000) })
    .eq("id", message.id);
  await admin.from("message_recipients").update({ delivery_state: "failed" }).eq("message_id", message.id);
  await finalizeJobQuota(admin, job.id, false);
  return status;
}

/** Process ONE claimed job. Never throws for provider errors; throws only on unexpected DB failures. */
export async function processOutboxJob(
  admin: AdminClient,
  adapter: EmailAdapter,
  job: OutboxJobRow,
  cfg: { maxAttempts: number } = getOutboxConfig(),
): Promise<JobOutcome> {
  const { data: message, error: msgErr } = await admin
    .from("messages")
    .select("*")
    .eq("id", job.message_id)
    .maybeSingle();
  if (msgErr) throw new Error(`failed to load message: ${msgErr.message}`);
  if (!message || message.direction !== "outbound") {
    await admin.from("outbox_jobs").update({ status: "failed", last_error: "message missing or not outbound", claimed_at: null, claimed_by: null }).eq("id", job.id);
    await finalizeJobQuota(admin, job.id, false);
    return "failed";
  }

  // Already submitted by an earlier attempt whose bookkeeping didn't finish.
  if (message.resend_email_id && message.lifecycle_state === "submitted") {
    await admin.from("outbox_jobs").update({ status: "succeeded", last_error: null, claimed_at: null, claimed_by: null }).eq("id", job.id);
    await finalizeJobQuota(admin, job.id, true);
    return "skipped";
  }

  // Re-check tenant state at send time (it may have changed since enqueue).
  const { data: ws } = await admin.from("workspaces").select("status").eq("id", message.workspace_id).maybeSingle();
  if (!ws || ws.status !== "active") {
    return markJobFailure(admin, job, message, { message: `workspace is ${ws?.status ?? "missing"}`, statusCode: null, retryable: false }, { action: "failed" });
  }

  const { data: recipients, error: rcErr } = await admin
    .from("message_recipients")
    .select("address, type")
    .eq("message_id", message.id);
  if (rcErr) throw new Error(`failed to load recipients: ${rcErr.message}`);
  if (!recipients?.some((r) => r.type === "to")) {
    return markJobFailure(admin, job, message, { message: "message has no 'to' recipient", statusCode: null, retryable: false }, { action: "failed" });
  }

  const attachments = await loadAttachments(admin, message.id);
  const result = await adapter.sendEmail(buildSendInput(message, recipients, attachments), {
    // Stable across retries; scoped by job id so tenants can never collide.
    idempotencyKey: `mc-outbox-${job.id}`,
  });

  if (!result.ok) {
    return markJobFailure(admin, job, message, result.error, decideFailure(result.error, job.attempts, cfg.maxAttempts));
  }

  const now = new Date().toISOString();
  const { error: upMsg } = await admin
    .from("messages")
    .update({ lifecycle_state: "submitted", resend_email_id: result.providerEmailId, sent_at: now, failure_reason: null })
    .eq("id", message.id);
  if (upMsg) throw new Error(`failed to record submission: ${upMsg.message}`);
  await admin.from("message_recipients").update({ delivery_state: "sent" }).eq("message_id", message.id).eq("delivery_state", "pending");
  await admin.from("outbox_jobs").update({ status: "succeeded", last_error: null, claimed_at: null, claimed_by: null }).eq("id", job.id);
  await finalizeJobQuota(admin, job.id, true);
  return "succeeded";
}

/**
 * One worker tick: claim a batch and process it. Safe to run concurrently from
 * many workers/cron invocations (claims use SKIP LOCKED + leases).
 */
export async function processOutbox(
  admin: AdminClient,
  adapter: EmailAdapter,
  opts: { workerId?: string; batchSize?: number } = {},
): Promise<ProcessSummary> {
  const cfg = getOutboxConfig();
  const workerId = opts.workerId ?? `worker-${nanoid(8)}`;
  const jobs = await claimOutboxJobs(admin, workerId, opts.batchSize);
  const summary: ProcessSummary = { claimed: jobs.length, succeeded: 0, retryScheduled: 0, failed: 0, dead: 0, skipped: 0 };

  for (const job of jobs) {
    try {
      const outcome = await processOutboxJob(admin, adapter, job, cfg);
      if (outcome === "succeeded") summary.succeeded++;
      else if (outcome === "retry_scheduled") summary.retryScheduled++;
      else if (outcome === "failed") summary.failed++;
      else if (outcome === "dead") summary.dead++;
      else summary.skipped++;
    } catch (err) {
      // Unexpected (DB) failure: put the job back with backoff; the idempotency key protects against dupes.
      const message = err instanceof Error ? err.message : String(err);
      const decision = decideFailure({ retryable: true }, job.attempts, cfg.maxAttempts);
      const next = decision.action === "retry" ? new Date(Date.now() + decision.delaySeconds * 1000).toISOString() : new Date().toISOString();
      await admin
        .from("outbox_jobs")
        .update(
          decision.action === "retry"
            ? { status: "pending", next_attempt_at: next, last_error: message.slice(0, 1000), claimed_at: null, claimed_by: null }
            : { status: "dead", last_error: message.slice(0, 1000), claimed_at: null, claimed_by: null },
        )
        .eq("id", job.id);
      if (decision.action === "retry") summary.retryScheduled++;
      else {
        await admin.from("messages").update({ lifecycle_state: "failed", failure_reason: message.slice(0, 1000) }).eq("id", job.message_id);
        await finalizeJobQuota(admin, job.id, false).catch(() => undefined);
        summary.dead++;
      }
    }
  }
  return summary;
}

/** Alias used by the cron route (one claim+process tick). */
export const processOutboxBatch = processOutbox;
