import type Stripe from "stripe";
import { planLimits, type PlanId } from "@/lib/billing/plans";
import { getStripe } from "@/lib/billing/stripe";
import type { AdminClient } from "@/lib/supabase/admin";
import type { WorkspaceRow } from "@/lib/types/database";

/** Ensure the workspace has a Stripe Customer; create one if missing. */
export async function ensureStripeCustomer(
  admin: AdminClient,
  workspace: Pick<WorkspaceRow, "id" | "name" | "slug" | "stripe_customer_id" | "billing_email">,
  email: string,
): Promise<string> {
  if (workspace.stripe_customer_id) return workspace.stripe_customer_id;

  const stripe = getStripe();
  const customer = await stripe.customers.create({
    email,
    name: workspace.name,
    metadata: {
      workspace_id: workspace.id,
      workspace_slug: workspace.slug,
    },
  });

  const { error } = await admin
    .from("workspaces")
    .update({
      stripe_customer_id: customer.id,
      billing_email: email,
    })
    .eq("id", workspace.id)
    .is("stripe_customer_id", null);

  if (error) {
    // Race: another request created the customer — prefer the DB value.
    const { data } = await admin.from("workspaces").select("stripe_customer_id").eq("id", workspace.id).maybeSingle();
    if (data?.stripe_customer_id) return data.stripe_customer_id;
    throw new Error(error.message);
  }

  return customer.id;
}

export async function applyPlanToWorkspace(admin: AdminClient, workspaceId: string, plan: PlanId): Promise<void> {
  const limits = planLimits(plan);
  const { error } = await admin
    .from("workspaces")
    .update({
      plan,
      monthly_sending_limit: limits.monthly_sending_limit,
      monthly_ai_limit: limits.monthly_ai_limit,
    })
    .eq("id", workspaceId);
  if (error) throw new Error(error.message);
}

export async function findWorkspaceByStripeCustomer(
  admin: AdminClient,
  customerId: string | null | undefined,
): Promise<WorkspaceRow | null> {
  if (!customerId) return null;
  const { data, error } = await admin.from("workspaces").select("*").eq("stripe_customer_id", customerId).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export function customerIdFromStripe(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined,
): string | null {
  if (!customer) return null;
  return typeof customer === "string" ? customer : customer.id;
}
