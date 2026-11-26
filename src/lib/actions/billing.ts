"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ensureStripeCustomer } from "@/lib/billing/customers";
import { isPlanId, type PlanId } from "@/lib/billing/plans";
import { getStripe, isStripeConfigured } from "@/lib/billing/stripe";
import { syncPaymentsFromStripe } from "@/lib/billing/sync";
import { getRequestAppUrl, getStripeConfig } from "@/lib/env";
import { requireWorkspaceAction } from "@/lib/data/workspace";
import { createAdminClient } from "@/lib/supabase/admin";
import { formString, guarded } from "./guard";
import { fail, ok, type ActionState } from "./state";

function priceIdForPlan(plan: PlanId): string | null {
  const { priceIds } = getStripeConfig();
  return priceIds[plan];
}

/** Start Stripe Checkout for a plan subscription. Redirects to Stripe. */
export async function startCheckoutAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return guarded(async () => {
    if (!isStripeConfigured()) {
      return fail("Stripe is not configured. Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.");
    }

    const slug = formString(formData, "slug");
    const plan = formString(formData, "plan");
    if (!isPlanId(plan)) return fail("Choose a valid plan.", { plan: "Invalid plan" });

    const priceId = priceIdForPlan(plan);
    if (!priceId) {
      return fail(`Stripe price for ${plan} is not configured. Set STRIPE_PRICE_${plan.toUpperCase()}.`);
    }

    const ctx = await requireWorkspaceAction({ slug }, "admin");
    const admin = createAdminClient();
    const email = ctx.user.email;
    if (!email) return fail("Your account needs an email address to start billing.");

    const customerId = await ensureStripeCustomer(admin, ctx.workspace, email);
    const origin = await getRequestAppUrl();
    const stripe = getStripe();

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: ctx.workspace.id,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/w/${slug}/settings/billing?checkout=success`,
      cancel_url: `${origin}/w/${slug}/settings/billing?checkout=canceled`,
      metadata: {
        workspace_id: ctx.workspace.id,
        workspace_slug: slug,
        plan,
      },
      subscription_data: {
        metadata: {
          workspace_id: ctx.workspace.id,
          workspace_slug: slug,
          plan,
        },
      },
      allow_promotion_codes: true,
    });

    if (!session.url) return fail("Stripe did not return a checkout URL.");
    redirect(session.url);
  });
}

/** Open the Stripe Customer Portal for invoices, payment methods, and cancels. */
export async function openBillingPortalAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return guarded(async () => {
    if (!isStripeConfigured()) {
      return fail("Stripe is not configured.");
    }

    const slug = formString(formData, "slug");
    const ctx = await requireWorkspaceAction({ slug }, "admin");
    if (!ctx.workspace.stripe_customer_id) {
      return fail("No Stripe customer yet. Subscribe to a plan first.");
    }

    const origin = await getRequestAppUrl();
    const stripe = getStripe();
    const portal = await stripe.billingPortal.sessions.create({
      customer: ctx.workspace.stripe_customer_id,
      return_url: `${origin}/w/${slug}/settings/billing`,
    });

    if (!portal.url) return fail("Stripe did not return a portal URL.");
    redirect(portal.url);
  });
}

/**
 * Pull paid invoices from Stripe into the local payment ledger.
 * Needed on localhost when Dashboard webhooks cannot reach the app, and as a
 * backfill after Checkout success.
 */
export async function syncPaymentsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return guarded(async () => {
    if (!isStripeConfigured()) return fail("Stripe is not configured.");

    const slug = formString(formData, "slug");
    const ctx = await requireWorkspaceAction({ slug }, "admin");
    if (!ctx.workspace.stripe_customer_id) {
      return fail("No Stripe customer on this workspace yet. Complete Checkout first.");
    }

    const admin = createAdminClient();
    const { imported } = await syncPaymentsFromStripe(admin, ctx.workspace);
    revalidatePath(`/w/${slug}/settings/billing`);
    return ok(
      imported > 0
        ? `Imported ${imported} payment${imported === 1 ? "" : "s"} from Stripe.`
        : "Already up to date — no new paid invoices found.",
    );
  });
}
