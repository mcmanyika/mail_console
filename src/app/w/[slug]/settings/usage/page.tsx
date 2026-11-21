import type { Metadata } from "next";
import { Suspense } from "react";
import { VolumeChart } from "@/components/admin/volume-chart";
import { Alert } from "@/components/ui/alert";
import { PageHeader, Panel, PanelHeader } from "@/components/ui/panel";
import { SkeletonRows } from "@/components/ui/skeleton";
import { UsageBar } from "@/components/ui/usage-bar";
import { gateSection, getAdminUsageExtras, getUsage } from "@/lib/data/settings";
import { formatNumber, formatRelative, monthLabel } from "@/lib/format";
import { roleAtLeast } from "@/lib/auth/authz";

export const metadata: Metadata = { title: "Usage" };

export default function UsagePage({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <>
      <PageHeader title="Usage" description="Sending against your monthly limit. One unit is one unique recipient (To, Cc or Bcc)." />
      <Suspense fallback={<SkeletonRows rows={5} />}>
        <Body params={params} />
      </Suspense>
    </>
  );
}

async function Body({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { ctx } = await gateSection(slug, "usage");
  const { quota, history } = await getUsage(ctx);
  const used = quota.reserved + quota.settled;
  const ratio = quota.limit > 0 ? used / quota.limit : 0;
  const isAdmin = roleAtLeast(ctx.role, "admin");
  const extras = isAdmin ? await getAdminUsageExtras(ctx) : null;

  return (
    <div className="space-y-6">
      {ratio >= 1 ? (
        <Alert tone="danger" title="Monthly limit reached">
          New sends are refused until the month rolls over (UTC) or a platform admin raises your limit.
        </Alert>
      ) : ratio >= 0.8 ? (
        <Alert tone="warn" title="Approaching your monthly limit">
          You&apos;ve used {Math.round(ratio * 100)}% of this month&apos;s allowance.
        </Alert>
      ) : null}

      <Panel>
        <PanelHeader title={`${monthLabel(quota.yearMonth)} ${quota.yearMonth.slice(0, 4)}`} description="Resets on the 1st, UTC." />
        <div className="p-5">
          <p className="font-serif text-4xl font-semibold tabular-nums text-ink">
            {formatNumber(used)}
            <span className="ml-2 text-lg font-normal text-muted">of {formatNumber(quota.limit)} recipients</span>
          </p>
          <UsageBar used={used} limit={quota.limit} className="mt-4 h-2.5" label="Monthly usage" />
          <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted">Submitted</dt>
              <dd className="font-serif text-xl font-semibold tabular-nums text-ink">{formatNumber(quota.settled)}</dd>
              <dd className="text-xs text-muted">Accepted by the provider</dd>
            </div>
            <div>
              <dt className="text-muted">Reserved</dt>
              <dd className="font-serif text-xl font-semibold tabular-nums text-ink">{formatNumber(quota.reserved)}</dd>
              <dd className="text-xs text-muted">Queued, not yet sent</dd>
            </div>
            <div>
              <dt className="text-muted">Remaining</dt>
              <dd className="font-serif text-xl font-semibold tabular-nums text-ink">{formatNumber(quota.remaining)}</dd>
              <dd className="text-xs text-muted">Failed sends release their reservation</dd>
            </div>
          </dl>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Last 6 months" />
        <div className="p-5">
          <VolumeChart data={history} />
        </div>
      </Panel>

      {extras ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <Panel>
            <PanelHeader title="Send queue" description="Outbound jobs" />
            <dl className="grid grid-cols-5 divide-x divide-line text-center">
              {(["pending", "processing", "succeeded", "failed", "dead"] as const).map((s) => (
                <div key={s} className="px-2 py-4">
                  <dd className={`font-serif text-xl font-semibold tabular-nums ${(s === "failed" || s === "dead") && extras.outbox[s] > 0 ? "text-danger" : "text-ink"}`}>
                    {extras.outbox[s]}
                  </dd>
                  <dt className="text-[11px] capitalize text-muted">{s}</dt>
                </div>
              ))}
            </dl>
          </Panel>
          <Panel>
            <PanelHeader title="Recent activity" description="Settings and access changes" />
            {extras.audit.length === 0 ? (
              <p className="px-5 py-6 text-sm text-muted">Nothing yet.</p>
            ) : (
              <ul className="max-h-72 divide-y divide-line overflow-y-auto">
                {extras.audit.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-[13px]">
                    <span>
                      <code className="rounded bg-canvas-deep px-1.5 py-0.5 font-mono text-xs text-ink">{a.action}</code>
                      <span className="ml-2 text-muted">{a.actor}</span>
                    </span>
                    <span className="text-xs text-muted">{formatRelative(a.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      ) : null}
    </div>
  );
}
