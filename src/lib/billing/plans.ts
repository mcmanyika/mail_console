/**
 * Commercial plans for Mail Console workspaces.
 * Catalog prices mirror Stripe Price IDs (STRIPE_PRICE_*). Checkout + webhooks
 * apply limits; selecting a plan sets monthly_sending_limit + monthly_ai_limit.
 */

export const PLAN_IDS = ["starter", "growth", "scale"] as const;
export type PlanId = (typeof PLAN_IDS)[number];
export type WorkspacePlan = PlanId | "custom";

export type PlanDef = {
  id: PlanId;
  name: string;
  priceMonthlyUsd: number;
  tagline: string;
  monthlySendingLimit: number;
  monthlyAiLimit: number;
  maxMailboxes: number | null; // null = fair-use / unlimited in catalog
  maxSeats: number;
  maxCampaignContacts: number;
  features: string[];
  recommended?: boolean;
};

export const PLANS: Record<PlanId, PlanDef> = {
  starter: {
    id: "starter",
    name: "Starter",
    priceMonthlyUsd: 49,
    tagline: "Small client or early ops",
    monthlySendingLimit: 3_000,
    monthlyAiLimit: 50,
    maxMailboxes: 2,
    maxSeats: 3,
    maxCampaignContacts: 500,
    features: ["Shared inbox & domains", "Templates", "Campaigns up to 500 contacts", "AI assist (50/mo)"],
  },
  growth: {
    id: "growth",
    name: "Growth",
    priceMonthlyUsd: 149,
    tagline: "Default for most agency clients",
    monthlySendingLimit: 15_000,
    monthlyAiLimit: 300,
    maxMailboxes: 10,
    maxSeats: 10,
    maxCampaignContacts: 5_000,
    features: ["Everything in Starter", "Transactional API", "Campaigns up to 5,000", "AI assist (300/mo)"],
    recommended: true,
  },
  scale: {
    id: "scale",
    name: "Scale",
    priceMonthlyUsd: 399,
    tagline: "Higher volume and larger teams",
    monthlySendingLimit: 50_000,
    monthlyAiLimit: 1_000,
    maxMailboxes: null,
    maxSeats: 25,
    maxCampaignContacts: 5_000,
    features: ["Everything in Growth", "Fair-use mailboxes", "25 seats", "AI assist (1,000/mo)"],
  },
};

export const PLAN_LIST: PlanDef[] = PLAN_IDS.map((id) => PLANS[id]);

export function isPlanId(value: string | null | undefined): value is PlanId {
  return !!value && (PLAN_IDS as readonly string[]).includes(value);
}

export function getPlan(id: WorkspacePlan | string | null | undefined): PlanDef | null {
  return isPlanId(id) ? PLANS[id] : null;
}

export function formatPlanPrice(plan: PlanDef): string {
  return `$${plan.priceMonthlyUsd}/mo`;
}

export function planLimits(id: PlanId): { monthly_sending_limit: number; monthly_ai_limit: number } {
  const p = PLANS[id];
  return { monthly_sending_limit: p.monthlySendingLimit, monthly_ai_limit: p.monthlyAiLimit };
}
