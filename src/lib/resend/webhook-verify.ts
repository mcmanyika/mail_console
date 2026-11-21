import { Webhook, WebhookVerificationError as SvixVerificationError } from "svix";
import { WebhookVerificationError, type ProviderWebhookEvent } from "./types";

/**
 * Verifies a Resend (Svix) webhook against the RAW request body.
 *
 * Never pass re-serialised JSON: the signature covers the exact bytes Resend
 * sent. Throws `WebhookVerificationError` for every invalid/missing/stale
 * signature (svix enforces a 5 minute timestamp tolerance).
 */
export function verifySvixWebhook(rawBody: string, headers: Headers, secret: string): ProviderWebhookEvent {
  const svixHeaders = {
    "svix-id": headers.get("svix-id") ?? "",
    "svix-timestamp": headers.get("svix-timestamp") ?? "",
    "svix-signature": headers.get("svix-signature") ?? "",
  };
  if (!svixHeaders["svix-id"] || !svixHeaders["svix-timestamp"] || !svixHeaders["svix-signature"]) {
    throw new WebhookVerificationError("Missing svix signature headers");
  }
  let payload: unknown;
  try {
    // svix >= 2.x `verify()` returns void; it only checks the signature over the raw bytes.
    new Webhook(secret).verify(rawBody, svixHeaders);
    payload = JSON.parse(rawBody);
  } catch (err) {
    if (err instanceof SvixVerificationError) throw new WebhookVerificationError();
    throw new WebhookVerificationError("Webhook verification failed");
  }
  if (!payload || typeof payload !== "object") throw new WebhookVerificationError("Malformed webhook payload");
  const raw = payload as Record<string, unknown>;
  return {
    eventId: svixHeaders["svix-id"],
    type: String(raw.type ?? "unknown"),
    createdAt: typeof raw.created_at === "string" ? raw.created_at : new Date().toISOString(),
    data: (raw.data && typeof raw.data === "object" ? raw.data : {}) as Record<string, unknown>,
    raw,
  };
}
