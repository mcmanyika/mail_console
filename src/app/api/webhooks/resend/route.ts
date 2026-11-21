import { NextResponse } from "next/server";
import { getEmailAdapter, getWebhookProviderAccount, RESEND_PROVIDER } from "@/lib/resend";
import { handleResendWebhook } from "@/lib/email/webhooks";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 60;

/**
 * POST /api/webhooks/resend
 *
 * Reads the RAW body (`request.text()`) — the Svix signature is computed over
 * the exact bytes, so the body must never be parsed/re-serialised before
 * verification. Public path (see PUBLIC_PATH_PREFIXES); authenticity comes from
 * the signature, not a session.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  try {
    const result = await handleResendWebhook({
      admin: createAdminClient(),
      adapter: getEmailAdapter(),
      rawBody,
      headers: request.headers,
      provider: RESEND_PROVIDER,
      account: getWebhookProviderAccount(),
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    // Intake itself failed (e.g. database down): NOT acknowledged, provider will retry.
    console.error("[webhooks/resend] intake failed", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "intake_failed" }, { status: 500 });
  }
}
