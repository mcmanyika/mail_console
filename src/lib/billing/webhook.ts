import type Stripe from "stripe";
import {
  applyPlanToWorkspace,
  customerIdFromStripe,
  findWorkspaceByStripeCustomer,
} from "@/lib/billing/customers";
import { isPlanId, type PlanId } from "@/lib/billing/plans";
import { getStripe, isStripeConfigured } from "@/lib/billing/stripe";
import { getStripeConfig } from "@/lib/env";
import type { AdminClient } from "@/lib/supabase/admin";
import type { PaymentStatus } from "@/lib/types/database";

export type StripeWebhookResult = {
  status: number;
  body: { received: boolean; handled?: string; ignored?: string; error?: string };
};

/**
 * Verify the Stripe signature and process payment / subscription events.
 * Successful charges are written to `payments` idempotently (unique on
 * stripe_event_id and stripe_invoice_id) so the customer dashboard always
 * reflects every paid invoice automatically.
 */
export async function handleStripeWebhook(args: {
  admin: AdminClient;
  rawBody: string;
  signature: string | null;
}): Promise<StripeWebhookResult> {
  if (!isStripeConfigured()) {
    return { status: 503, body: { received: false, error: "stripe_not_configured" } };
  }
  if (!args.signature) {
    return { status: 400, body: { received: false, error: "missing_signature" } };
  }

  const stripe = getStripe();
  const { webhookSecret } = getStripeConfig();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(args.rawBody, args.signature, webhookSecret);
  } catch (err) {
    console.error("[webhooks/stripe] signature verify failed", err instanceof Error ? err.message : err);
    return { status: 400, body: { received: false, error: "invalid_signature" } };
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await onCheckoutCompleted(args.admin, event);
        break;
      case "invoice.paid":
        await onInvoicePaid(args.admin, event);
        break;
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await onSubscriptionChanged(args.admin, event);
        break;
      case "charge.refunded":
        await onChargeRefunded(args.admin, event);
        break;
      default:
        return { status: 200, body: { received: true, ignored: event.type } };
    }
    return { status: 200, body: { received: true, handled: event.type } };
  } catch (err) {
    console.error("[webhooks/stripe] handler failed", event.type, err instanceof Error ? err.message : err);
    throw err;
  }
}

async function onCheckoutCompleted(admin: AdminClient, event: Stripe.Event): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session;
  const workspaceId = session.metadata?.workspace_id ?? null;
  const planRaw = session.metadata?.plan ?? null;
  const customerId = customerIdFromStripe(session.customer);
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;

  let workspace = workspaceId
    ? (await admin.from("workspaces").select("*").eq("id", workspaceId).maybeSingle()).data
    : null;
  if (!workspace) workspace = await findWorkspaceByStripeCustomer(admin, customerId);
  if (!workspace) {
    console.warn("[webhooks/stripe] checkout.session.completed: no workspace", session.id);
    return;
  }

  const patch: {
    stripe_customer_id?: string;
    stripe_subscription_id?: string;
    billing_email?: string | null;
  } = {};
  if (customerId && workspace.stripe_customer_id !== customerId) patch.stripe_customer_id = customerId;
  if (subscriptionId) patch.stripe_subscription_id = subscriptionId;
  if (session.customer_email || session.customer_details?.email) {
    patch.billing_email = session.customer_email ?? session.customer_details?.email ?? null;
  }
  if (Object.keys(patch).length > 0) {
    await admin.from("workspaces").update(patch).eq("id", workspace.id);
  }

  if (isPlanId(planRaw)) {
    await applyPlanToWorkspace(admin, workspace.id, planRaw);
  }

  // Record when Checkout reports paid. Subscriptions normally also get
  // invoice.paid; insertPayment is idempotent on invoice id.
  if (session.payment_status === "paid") {
    const amount = session.amount_total ?? 0;
    const invoiceId = typeof session.invoice === "string" ? session.invoice : session.invoice?.id ?? null;
    await insertPayment(admin, {
      workspaceId: workspace.id,
      stripeEventId: event.id,
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null,
      stripeInvoiceId: invoiceId,
      stripeCustomerId: customerId,
      amountCents: amount,
      currency: session.currency ?? "usd",
      status: "succeeded",
      plan: isPlanId(planRaw) ? planRaw : null,
      description: planRaw ? `${planRaw} checkout` : session.mode === "subscription" ? "Subscription payment" : "Checkout payment",
      paidAt: new Date((session.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    });
  }
}

async function onInvoicePaid(admin: AdminClient, event: Stripe.Event): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;
  if (invoice.status !== "paid" && invoice.paid !== true) return;

  const customerId = customerIdFromStripe(invoice.customer);
  const workspace = await resolveWorkspaceForInvoice(admin, invoice, customerId);
  if (!workspace) {
    console.warn("[webhooks/stripe] invoice.paid: no workspace", invoice.id);
    return;
  }

  const subscriptionId =
    typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id ?? null;
  if (subscriptionId && workspace.stripe_subscription_id !== subscriptionId) {
    await admin.from("workspaces").update({ stripe_subscription_id: subscriptionId }).eq("id", workspace.id);
  }
  if (customerId && !workspace.stripe_customer_id) {
    await admin.from("workspaces").update({ stripe_customer_id: customerId }).eq("id", workspace.id);
  }

  const plan = planFromInvoice(invoice) ?? (isPlanId(workspace.plan) ? workspace.plan : null);
  if (plan) await applyPlanToWorkspace(admin, workspace.id, plan);

  const paymentIntentId =
    typeof invoice.payment_intent === "string" ? invoice.payment_intent : invoice.payment_intent?.id ?? null;

  let receiptUrl: string | null = null;
  if (paymentIntentId) {
    try {
      const stripe = getStripe();
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
      const charge = pi.latest_charge;
      if (charge && typeof charge !== "string") receiptUrl = charge.receipt_url;
    } catch {
      // Receipt is best-effort.
    }
  }

  await insertPayment(admin, {
    workspaceId: workspace.id,
    stripeEventId: event.id,
    stripeCheckoutSessionId: null,
    stripePaymentIntentId: paymentIntentId,
    stripeInvoiceId: invoice.id,
    stripeCustomerId: customerId,
    amountCents: invoice.amount_paid ?? 0,
    currency: invoice.currency ?? "usd",
    status: "succeeded",
    plan,
    description: invoice.description || invoice.lines?.data?.[0]?.description || "Subscription payment",
    receiptUrl,
    paidAt: new Date((invoice.status_transitions?.paid_at ?? invoice.created) * 1000).toISOString(),
  });
}

async function onSubscriptionChanged(admin: AdminClient, event: Stripe.Event): Promise<void> {
  const sub = event.data.object as Stripe.Subscription;
  const customerId = customerIdFromStripe(sub.customer);
  const workspace = await findWorkspaceByStripeCustomer(admin, customerId);
  if (!workspace) return;

  if (event.type === "customer.subscription.deleted") {
    await admin.from("workspaces").update({ stripe_subscription_id: null }).eq("id", workspace.id);
    return;
  }

  if (workspace.stripe_subscription_id !== sub.id) {
    await admin.from("workspaces").update({ stripe_subscription_id: sub.id }).eq("id", workspace.id);
  }
  const plan = planFromSubscription(sub);
  if (plan && sub.status === "active") {
    await applyPlanToWorkspace(admin, workspace.id, plan);
  }
}

async function onChargeRefunded(admin: AdminClient, event: Stripe.Event): Promise<void> {
  const charge = event.data.object as Stripe.Charge;
  const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id ?? null;
  const invoiceId = typeof charge.invoice === "string" ? charge.invoice : charge.invoice?.id ?? null;

  if (invoiceId) {
    await admin.from("payments").update({ status: "refunded" as PaymentStatus }).eq("stripe_invoice_id", invoiceId);
  } else if (paymentIntentId) {
    await admin.from("payments").update({ status: "refunded" as PaymentStatus }).eq("stripe_payment_intent_id", paymentIntentId);
  }
}

async function resolveWorkspaceForInvoice(
  admin: AdminClient,
  invoice: Stripe.Invoice,
  customerId: string | null,
) {
  const metaWs = invoice.metadata?.workspace_id || invoice.subscription_details?.metadata?.workspace_id;
  if (metaWs) {
    const { data } = await admin.from("workspaces").select("*").eq("id", metaWs).maybeSingle();
    if (data) return data;
  }
  const lineMeta = invoice.lines?.data?.[0]?.metadata?.workspace_id;
  if (lineMeta) {
    const { data } = await admin.from("workspaces").select("*").eq("id", lineMeta).maybeSingle();
    if (data) return data;
  }
  return findWorkspaceByStripeCustomer(admin, customerId);
}

function planFromInvoice(invoice: Stripe.Invoice): PlanId | null {
  const candidates = [
    invoice.metadata?.plan,
    invoice.subscription_details?.metadata?.plan,
    invoice.lines?.data?.[0]?.metadata?.plan,
    invoice.lines?.data?.[0]?.price?.metadata?.plan,
  ];
  for (const c of candidates) {
    if (isPlanId(c)) return c;
  }
  return null;
}

function planFromSubscription(sub: Stripe.Subscription): PlanId | null {
  if (isPlanId(sub.metadata?.plan)) return sub.metadata.plan;
  const pricePlan = sub.items.data[0]?.price?.metadata?.plan;
  if (isPlanId(pricePlan)) return pricePlan;
  return null;
}

async function insertPayment(
  admin: AdminClient,
  row: {
    workspaceId: string;
    stripeEventId: string;
    stripeCheckoutSessionId: string | null;
    stripePaymentIntentId: string | null;
    stripeInvoiceId: string | null;
    stripeCustomerId: string | null;
    amountCents: number;
    currency: string;
    status: PaymentStatus;
    plan: PlanId | null;
    description: string | null;
    receiptUrl?: string | null;
    paidAt: string;
  },
): Promise<void> {
  // Prefer invoice uniqueness when present (Stripe may retry with a new event id
  // in rare cases; invoice id is the business key for subscription payments).
  if (row.stripeInvoiceId) {
    const { data: existing } = await admin
      .from("payments")
      .select("id")
      .eq("stripe_invoice_id", row.stripeInvoiceId)
      .maybeSingle();
    if (existing) return;
  }

  const { error } = await admin.from("payments").insert({
    workspace_id: row.workspaceId,
    stripe_event_id: row.stripeEventId,
    stripe_checkout_session_id: row.stripeCheckoutSessionId,
    stripe_payment_intent_id: row.stripePaymentIntentId,
    stripe_invoice_id: row.stripeInvoiceId,
    stripe_customer_id: row.stripeCustomerId,
    amount_cents: row.amountCents,
    currency: row.currency,
    status: row.status,
    plan: row.plan,
    description: row.description,
    receipt_url: row.receiptUrl ?? null,
    paid_at: row.paidAt,
  });

  if (error) {
    // Idempotent: duplicate event or invoice.
    if (error.code === "23505") return;
    throw new Error(error.message);
  }
}
