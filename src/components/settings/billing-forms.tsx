"use client";

import { openBillingPortalAction, startCheckoutAction, syncPaymentsAction } from "@/lib/actions/billing";
import { formatPlanPrice, type PlanDef } from "@/lib/billing/plans";
import { ActionForm } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function SubscribeButton({
  slug,
  plan,
  current,
  recommended,
}: {
  slug: string;
  plan: PlanDef;
  current: boolean;
  recommended?: boolean;
}) {
  return (
    <ActionForm action={startCheckoutAction} hideSuccessMessage className="space-y-0">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="plan" value={plan.id} />
      <Button type="submit" variant={recommended || current ? "primary" : "secondary"} className="w-full justify-center" disabled={current}>
        {current ? "Current plan" : `Subscribe · ${formatPlanPrice(plan)}`}
      </Button>
    </ActionForm>
  );
}

export function ManageBillingButton({ slug, disabled }: { slug: string; disabled?: boolean }) {
  return (
    <ActionForm action={openBillingPortalAction} hideSuccessMessage className={cn("space-y-0", disabled && "opacity-60")}>
      <input type="hidden" name="slug" value={slug} />
      <Button type="submit" variant="secondary" disabled={disabled}>
        Customer portal
      </Button>
    </ActionForm>
  );
}

export function SyncPaymentsButton({ slug, disabled }: { slug: string; disabled?: boolean }) {
  return (
    <ActionForm action={syncPaymentsAction} className={cn(disabled && "opacity-60")}>
      <input type="hidden" name="slug" value={slug} />
      <Button type="submit" variant="secondary" disabled={disabled}>
        Sync from Stripe
      </Button>
    </ActionForm>
  );
}
