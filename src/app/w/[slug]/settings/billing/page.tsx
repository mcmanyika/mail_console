import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { ManageBillingButton, SubscribeButton, SyncPaymentsButton } from "@/components/settings/billing-forms";
import { SectionDenied } from "@/components/settings/section-denied";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { PageHeader, Panel, PanelHeader } from "@/components/ui/panel";
import { SkeletonRows } from "@/components/ui/skeleton";
import { formatPlanPrice, getPlan, PLAN_LIST } from "@/lib/billing/plans";
import { isStripeConfigured } from "@/lib/billing/stripe";
import { syncPaymentsFromStripe } from "@/lib/billing/sync";
import { gateSection, getPayments } from "@/lib/data/settings";
import { formatFullDate, formatNumber } from "@/lib/format";
import { createAdminClient } from "@/lib/supabase/admin";
import { cn } from "@/lib/utils";
import type { PaymentStatus } from "@/lib/types/database";

export const metadata: Metadata = { title: "Billing" };

export default function BillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ checkout?: string; sync?: string }>;
}) {
  return (
    <>
      <PageHeader
        title="Billing"
        description="Subscribe with Stripe. Successful payments are recorded automatically for this workspace."
      />
      <Suspense fallback={<SkeletonRows rows={6} />}>
        <Body params={params} searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Body({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ checkout?: string; sync?: string }>;
}) {
  // Payment timestamps / date-fns formatting — opt into request time.
  await connection();
  const { slug } = await params;
  const sp = await searchParams;
  const gate = await gateSection(slug, "billing");
  if (!gate.allowed) return <SectionDenied slug={slug} section="Billing" />;

  const { ctx } = gate;
  const stripeReady = isStripeConfigured();
  const hasCustomer = Boolean(ctx.workspace.stripe_customer_id);

  let syncNote: string | null = null;
  if (stripeReady && hasCustomer && (sp.checkout === "success" || sp.sync === "1")) {
    try {
      const { imported } = await syncPaymentsFromStripe(createAdminClient(), ctx.workspace);
      syncNote =
        imported > 0
          ? `Imported ${imported} payment${imported === 1 ? "" : "s"} from Stripe.`
          : "Synced with Stripe — payment history is up to date.";
    } catch (err) {
      console.error("[billing] sync failed", err instanceof Error ? err.message : err);
      syncNote = "Could not sync from Stripe. Use Sync from Stripe below, or check that migration 00008 is applied.";
    }
  }

  const payments = await getPayments(ctx);
  const plan = getPlan(ctx.workspace.plan);

  return (
    <div className="space-y-6">
      {sp.checkout === "success" ? (
        <Alert tone="success" title="Checkout complete">
          {syncNote ?? "Stripe accepted the payment. Use Sync from Stripe if it is not listed yet."}
        </Alert>
      ) : null}
      {syncNote && sp.checkout !== "success" ? <Alert tone="success">{syncNote}</Alert> : null}
      {sp.checkout === "canceled" ? (
        <Alert tone="warn" title="Checkout canceled">
          No charge was made. You can try again whenever you are ready.
        </Alert>
      ) : null}
      {!stripeReady ? (
        <Alert tone="warn" title="Stripe not configured">
          Set <code className="font-mono text-xs">STRIPE_SECRET_KEY</code>,{" "}
          <code className="font-mono text-xs">STRIPE_WEBHOOK_SECRET</code>, and{" "}
          <code className="font-mono text-xs">STRIPE_PRICE_*</code> to enable checkout.
        </Alert>
      ) : null}

      <Panel>
        <PanelHeader
          title="Current plan"
          description={
            plan
              ? `${plan.name} · catalog ${formatPlanPrice(plan)}`
              : "Custom limits set by a platform admin"
          }
          actions={<ManageBillingButton slug={slug} disabled={!stripeReady || !hasCustomer} />}
        />
        <div className="space-y-3 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={plan ? "accent" : "neutral"}>{plan?.name ?? "Custom"}</Badge>
            {ctx.workspace.stripe_subscription_id ? (
              <Badge tone="success" dot>
                Stripe subscription
              </Badge>
            ) : (
              <Badge tone="neutral">No active Stripe subscription</Badge>
            )}
          </div>
          {ctx.workspace.billing_email ? (
            <p className="text-sm text-muted">
              Billing email: <span className="text-ink">{ctx.workspace.billing_email}</span>
            </p>
          ) : null}
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted">Monthly sends</dt>
              <dd className="font-medium tabular-nums text-ink">{formatNumber(ctx.workspace.monthly_sending_limit)}</dd>
            </div>
            <div>
              <dt className="text-muted">Monthly AI assists</dt>
              <dd className="font-medium tabular-nums text-ink">{formatNumber(ctx.workspace.monthly_ai_limit)}</dd>
            </div>
          </dl>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Packages" description="Checkout opens Stripe. Limits apply after a successful payment webhook." />
        <div className="grid gap-4 p-5 md:grid-cols-3">
          {PLAN_LIST.map((p) => {
            const current = ctx.workspace.plan === p.id;
            return (
              <article
                key={p.id}
                className={cn(
                  "flex flex-col rounded-lg border p-4",
                  p.recommended ? "border-accent ring-1 ring-accent/15" : "border-line",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-serif text-lg font-semibold text-ink">{p.name}</h3>
                  {p.recommended ? <Badge tone="accent">Recommended</Badge> : null}
                </div>
                <p className="mt-1 text-[13px] text-muted">{p.tagline}</p>
                <p className="mt-3 font-serif text-2xl font-semibold tabular-nums text-ink">
                  {formatPlanPrice(p).replace("/mo", "")}
                  <span className="ml-1 text-sm font-normal text-muted">/mo</span>
                </p>
                <ul className="mt-3 flex-1 space-y-1.5 text-[13px] text-ink-2">
                  {p.features.slice(0, 3).map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                <div className="mt-4">
                  <SubscribeButton slug={slug} plan={p} current={current && hasCustomer} recommended={p.recommended} />
                </div>
              </article>
            );
          })}
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          title="Payment history"
          description="Captured from Stripe webhooks, or pull manually if you are on localhost."
          actions={<SyncPaymentsButton slug={slug} disabled={!stripeReady || !hasCustomer} />}
        />
        {payments.length === 0 ? (
          <p className="px-5 py-8 text-sm text-muted">
            No payments yet. After Checkout, click <span className="text-ink">Sync from Stripe</span> (required on
            localhost unless you run <code className="font-mono text-xs">stripe listen</code>).
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-line bg-canvas-deep/60 text-[12px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Date</th>
                  <th className="px-5 py-2.5 font-medium">Description</th>
                  <th className="px-5 py-2.5 font-medium">Plan</th>
                  <th className="px-5 py-2.5 font-medium">Status</th>
                  <th className="px-5 py-2.5 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {payments.map((p) => (
                  <tr key={p.id} className="text-ink">
                    <td className="px-5 py-3 whitespace-nowrap text-ink-2">{formatFullDate(p.paid_at)}</td>
                    <td className="px-5 py-3">
                      <div>{p.description ?? "Payment"}</div>
                      {p.receipt_url ? (
                        <a
                          href={p.receipt_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[12px] font-medium text-accent hover:underline"
                        >
                          Receipt
                        </a>
                      ) : null}
                    </td>
                    <td className="px-5 py-3 capitalize text-ink-2">{p.plan ?? "—"}</td>
                    <td className="px-5 py-3">
                      <Badge tone={paymentTone(p.status)}>{p.status}</Badge>
                    </td>
                    <td className="px-5 py-3 text-right font-medium tabular-nums">
                      {formatMoney(p.amount_cents, p.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function paymentTone(status: PaymentStatus): "success" | "warn" | "danger" | "neutral" {
  if (status === "succeeded") return "success";
  if (status === "pending") return "warn";
  if (status === "failed" || status === "refunded") return "danger";
  return "neutral";
}

function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
