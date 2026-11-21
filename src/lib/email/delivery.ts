import type { AdminClient } from "@/lib/supabase/admin";
import type { DeliveryState } from "@/lib/types/database";
import { extractAddresses } from "./address";

/**
 * Delivery state machine for message_recipients.
 *
 * Webhooks can be duplicated and arrive out of order, so a state only ever
 * moves FORWARD by rank. Equal rank does not move (first writer wins), which
 * also makes redelivery a no-op.
 *
 *   pending(0) -> sent(1) -> delayed(2) -> delivered(3) -> failed/suppressed(4) -> bounced(5) -> complained(6)
 *
 * `received` is only used by inbound rows and is never produced from here.
 */
export const DELIVERY_RANK: Record<DeliveryState, number> = {
  pending: 0,
  received: 0,
  sent: 1,
  delayed: 2,
  delivered: 3,
  failed: 4,
  suppressed: 4,
  bounced: 5,
  complained: 6,
};

export const EVENT_TO_DELIVERY_STATE: Record<string, DeliveryState> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  "email.suppressed": "suppressed",
};

export function isDeliveryEvent(type: string): boolean {
  return type in EVENT_TO_DELIVERY_STATE;
}

export function shouldAdvanceDeliveryState(current: DeliveryState, next: DeliveryState): boolean {
  return DELIVERY_RANK[next] > DELIVERY_RANK[current];
}

/** States strictly below `next` — the only states a row may be updated FROM. */
export function statesBelow(next: DeliveryState): DeliveryState[] {
  return (Object.keys(DELIVERY_RANK) as DeliveryState[]).filter((s) => DELIVERY_RANK[s] < DELIVERY_RANK[next]);
}

export type DeliveryResult =
  | { outcome: "applied"; messageId: string; updated: number }
  | { outcome: "noop"; messageId: string } // duplicate / older than current state
  | { outcome: "message_not_found" };

/**
 * Applies a provider delivery event. The guard lives in the UPDATE's WHERE
 * clause (`delivery_state in (<lower ranks>)`), so concurrent/duplicate events
 * cannot regress a row even without a transaction.
 */
export async function applyDeliveryEvent(
  admin: AdminClient,
  event: { type: string; data: Record<string, unknown> },
): Promise<DeliveryResult> {
  const next = EVENT_TO_DELIVERY_STATE[event.type];
  if (!next) throw new Error(`not a delivery event: ${event.type}`);

  const providerEmailId = typeof event.data.email_id === "string" ? event.data.email_id : null;
  if (!providerEmailId) return { outcome: "message_not_found" };

  const { data: message, error } = await admin
    .from("messages")
    .select("id, workspace_id, lifecycle_state")
    .eq("resend_email_id", providerEmailId)
    .eq("direction", "outbound")
    .maybeSingle();
  if (error) throw new Error(`message lookup failed: ${error.message}`);
  if (!message) return { outcome: "message_not_found" };

  // Resend lists the affected recipient(s) in data.to. If none of those match
  // a stored recipient (e.g. the field is absent) the event applies to the
  // whole message.
  const affected = extractAddresses(Array.isArray(event.data.to) ? (event.data.to as string[]) : []);

  const apply = async (addresses: string[] | null) => {
    let q = admin
      .from("message_recipients")
      .update({ delivery_state: next })
      .eq("message_id", message.id)
      .in("delivery_state", statesBelow(next));
    if (addresses) q = q.in("address", addresses);
    const { data, error: upErr } = await q.select("id");
    if (upErr) throw new Error(`recipient update failed: ${upErr.message}`);
    return data?.length ?? 0;
  };

  let updated = 0;
  if (affected.length) {
    const { data: known, error: kErr } = await admin
      .from("message_recipients")
      .select("address")
      .eq("message_id", message.id)
      .in("address", affected);
    if (kErr) throw new Error(`recipient lookup failed: ${kErr.message}`);
    updated = known?.length ? await apply(affected) : await apply(null);
  } else {
    updated = await apply(null);
  }

  if (next === "failed" && message.lifecycle_state === "submitted") {
    const reason =
      typeof (event.data.failed as { reason?: unknown } | undefined)?.reason === "string"
        ? String((event.data.failed as { reason: string }).reason).slice(0, 1000)
        : "Provider reported a send failure";
    await admin.from("messages").update({ lifecycle_state: "failed", failure_reason: reason }).eq("id", message.id);
  }

  return updated > 0 ? { outcome: "applied", messageId: message.id, updated } : { outcome: "noop", messageId: message.id };
}

/** Roll-up used by the transactional API: one status for the whole message. */
export function aggregateDeliveryStatus(
  lifecycle: string,
  states: readonly DeliveryState[],
): "queued" | "sent" | "delivered" | "delayed" | "bounced" | "complained" | "failed" | "suppressed" {
  if (lifecycle === "queued") return "queued";
  if (lifecycle === "failed") return "failed";
  if (states.includes("complained")) return "complained";
  if (states.includes("bounced")) return "bounced";
  if (states.includes("failed")) return "failed";
  if (states.includes("suppressed")) return "suppressed";
  if (states.length > 0 && states.every((s) => s === "delivered")) return "delivered";
  if (states.includes("delayed")) return "delayed";
  return "sent";
}
