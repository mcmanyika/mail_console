import {
  applyPlanToWorkspace,
  findWorkspaceByStripeCustomer,
} from "@/lib/billing/customers";
import { isPlanId, type PlanId } from "@/lib/billing/plans";
import { getStripe } from "@/lib/billing/stripe";
import type { AdminClient } from "@/lib/supabase/admin";
import type { WorkspaceRow } from "@/lib/types/database";

/**
 * Pull paid invoices from Stripe into `payments` for a workspace.
 * Used when webhooks did not reach the app (e.g. localhost without
 * `stripe listen`) and after Checkout success as a reliability backfill.
 */
export async function syncPaymentsFromStripe(
  admin: AdminClient,
  workspace: Pick<WorkspaceRow, "id" | "plan" | "stripe_customer_id" | "stripe_subscription_id">,
): Promise<{ imported: number; customerId: string | null }> {
  const customerId = workspace.stripe_customer_id;
  if (!customerId) return { imported: 0, customerId: null };

  const stripe = getStripe();

  const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 10 });
  const active = subs.data.find((s) => s.status === "active" || s.status === "trialing") ?? subs.data[0];
  if (active) {
    const plan =
      (isPlanId(active.metadata?.plan) ? active.metadata.plan : null) ??
      (isPlanId(active.items.data[0]?.price?.metadata?.plan) ? (active.items.data[0].price.metadata.plan as PlanId) : null) ??
      (isPlanId(workspace.plan) ? workspace.plan : null);

    const patch: { stripe_subscription_id: string } = { stripe_subscription_id: active.id };
    await admin.from("workspaces").update(patch).eq("id", workspace.id);
    if (plan && (active.status === "active" || active.status === "trialing")) {
      await applyPlanToWorkspace(admin, workspace.id, plan);
    }
  }

  const invoices = await stripe.invoices.list({
    customer: customerId,
    status: "paid",
    limit: 50,
  });

  let imported = 0;
  for (const invoice of invoices.data) {
    if (!invoice.id) continue;

    const { data: existing } = await admin.from("payments").select("id").eq("stripe_invoice_id", invoice.id).maybeSingle();
    if (existing) continue;

    const plan =
      (isPlanId(invoice.metadata?.plan) ? invoice.metadata.plan : null) ??
      (isPlanId(invoice.subscription_details?.metadata?.plan) ? invoice.subscription_details.metadata.plan : null) ??
      (isPlanId(invoice.lines?.data?.[0]?.metadata?.plan) ? invoice.lines.data[0].metadata.plan : null) ??
      (isPlanId(workspace.plan) ? workspace.plan : null);

    const paymentIntentId =
      typeof invoice.payment_intent === "string" ? invoice.payment_intent : invoice.payment_intent?.id ?? null;

    let receiptUrl: string | null = null;
    if (paymentIntentId) {
      try {
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
        const charge = pi.latest_charge;
        if (charge && typeof charge !== "string") receiptUrl = charge.receipt_url;
      } catch {
        // best-effort
      }
    }

    const eventKey = `sync:${invoice.id}`;
    const { error } = await admin.from("payments").insert({
      workspace_id: workspace.id,
      stripe_event_id: eventKey,
      stripe_checkout_session_id: null,
      stripe_payment_intent_id: paymentIntentId,
      stripe_invoice_id: invoice.id,
      stripe_customer_id: customerId,
      amount_cents: invoice.amount_paid ?? 0,
      currency: invoice.currency ?? "usd",
      status: "succeeded",
      plan,
      description: invoice.description || invoice.lines?.data?.[0]?.description || "Subscription payment",
      receipt_url: receiptUrl,
      paid_at: new Date((invoice.status_transitions?.paid_at ?? invoice.created) * 1000).toISOString(),
    });

    if (error) {
      if (error.code === "23505") continue;
      throw new Error(error.message);
    }
    imported += 1;
  }

  return { imported, customerId };
}

/** Resolve workspace by Stripe customer and sync (webhook fallback helpers). */
export async function syncPaymentsForCustomer(admin: AdminClient, customerId: string): Promise<number> {
  const workspace = await findWorkspaceByStripeCustomer(admin, customerId);
  if (!workspace) return 0;
  const { imported } = await syncPaymentsFromStripe(admin, workspace);
  return imported;
}
