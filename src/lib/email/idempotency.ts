import { createHash } from "node:crypto";
import type { AdminClient } from "@/lib/supabase/admin";
import type { ApiIdempotencyKeyRow, Json } from "@/lib/types/database";

/**
 * Idempotency for POST /api/v1/emails, on top of api_idempotency_keys
 * (unique per integration + key):
 *
 *   same key + same payload (completed)  -> original response replayed
 *   same key + different payload         -> 409 idempotency_key_reuse
 *   same key, first request still running-> 409 request_in_progress
 *   same key, first request crashed      -> lock expires, a retry resumes it
 *
 * The row records the draft `message_id` BEFORE enqueueing, so a retry after a
 * crash re-enqueues the SAME message (enqueue_outbound_message is itself
 * idempotent on its key) instead of creating a second one.
 */

export const IDEMPOTENCY_LOCK_SECONDS = 60;

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export function hashRequest(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload), "utf8").digest("hex");
}

/** Key used for outbox_jobs.idempotency_key (unique per workspace). */
export function enqueueKeyFor(integrationId: string, idempotencyKey: string): string {
  return `api:${integrationId}:${createHash("sha256").update(idempotencyKey, "utf8").digest("hex").slice(0, 32)}`;
}

export type BeginResult =
  | { kind: "new"; row: ApiIdempotencyKeyRow }
  | { kind: "resume"; row: ApiIdempotencyKeyRow }
  | { kind: "replay"; status: number; body: Json }
  | { kind: "conflict" }
  | { kind: "in_progress" };

export async function beginIdempotentRequest(
  admin: AdminClient,
  p: { workspaceId: string; integrationId: string; key: string; requestHash: string; now?: Date },
  attempt = 0,
): Promise<BeginResult> {
  const now = p.now ?? new Date();
  const { data, error } = await admin
    .from("api_idempotency_keys")
    .insert({
      workspace_id: p.workspaceId,
      integration_id: p.integrationId,
      idempotency_key: p.key,
      request_hash: p.requestHash,
      locked_at: now.toISOString(),
    })
    .select("*")
    .single();
  if (!error && data) return { kind: "new", row: data };
  if (error?.code !== "23505") throw new Error(`idempotency insert failed: ${error?.message ?? "no data"}`);

  const { data: row, error: selErr } = await admin
    .from("api_idempotency_keys")
    .select("*")
    .eq("integration_id", p.integrationId)
    .eq("idempotency_key", p.key)
    .maybeSingle();
  if (selErr) throw new Error(`idempotency lookup failed: ${selErr.message}`);
  if (!row) {
    if (attempt < 2) return beginIdempotentRequest(admin, p, attempt + 1); // deleted between insert and select
    throw new Error("idempotency row vanished");
  }

  if (Date.parse(row.expires_at) < now.getTime()) {
    await admin.from("api_idempotency_keys").delete().eq("id", row.id).lt("expires_at", now.toISOString());
    if (attempt < 2) return beginIdempotentRequest(admin, p, attempt + 1);
    throw new Error("idempotency row expired repeatedly");
  }

  if (row.request_hash !== p.requestHash) return { kind: "conflict" };
  if (row.completed_at && row.response_status != null && row.response_body != null) {
    return { kind: "replay", status: row.response_status, body: row.response_body };
  }

  // First request is unfinished. Take over only if its lock is stale.
  const stale = now.getTime() - Date.parse(row.locked_at) > IDEMPOTENCY_LOCK_SECONDS * 1000;
  if (!stale) return { kind: "in_progress" };
  const { data: won, error: upErr } = await admin
    .from("api_idempotency_keys")
    .update({ locked_at: now.toISOString() })
    .eq("id", row.id)
    .eq("locked_at", row.locked_at) // optimistic: only one taker
    .is("completed_at", null)
    .select("*");
  if (upErr) throw new Error(`idempotency takeover failed: ${upErr.message}`);
  return won?.[0] ? { kind: "resume", row: won[0] } : { kind: "in_progress" };
}

export async function attachMessage(admin: AdminClient, id: string, messageId: string): Promise<void> {
  const { error } = await admin.from("api_idempotency_keys").update({ message_id: messageId }).eq("id", id);
  if (error) throw new Error(`idempotency attach failed: ${error.message}`);
}

export async function completeIdempotentRequest(
  admin: AdminClient,
  id: string,
  result: { status: number; body: Json; messageId: string },
): Promise<void> {
  const { error } = await admin
    .from("api_idempotency_keys")
    .update({
      response_status: result.status,
      response_body: result.body,
      message_id: result.messageId,
      completed_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(`idempotency complete failed: ${error.message}`);
}

/** Frees the key so the client can retry after a non-final failure (quota, validation…). */
export async function releaseIdempotentRequest(admin: AdminClient, id: string): Promise<void> {
  await admin.from("api_idempotency_keys").delete().eq("id", id).is("completed_at", null);
}
