import { NextResponse } from "next/server";
import { handleStripeWebhook } from "@/lib/billing/webhook";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 60;

/**
 * POST /api/webhooks/stripe
 *
 * Raw body required for signature verification. Public path
 * (`PUBLIC_PATH_PREFIXES`); authenticity is the Stripe signing secret.
 * Successful payments are persisted to `payments` for the customer dashboard.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  try {
    const result = await handleStripeWebhook({
      admin: createAdminClient(),
      rawBody,
      signature,
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    console.error("[webhooks/stripe] intake failed", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "intake_failed" }, { status: 500 });
  }
}
