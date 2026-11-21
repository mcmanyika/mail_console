import type { Metadata } from "next";
import { Suspense } from "react";
import { AttentionPanel } from "@/components/admin/attention-panel";
import { StatCard } from "@/components/admin/stat-card";
import { VolumeChart } from "@/components/admin/volume-chart";
import { WorkspaceTable } from "@/components/admin/workspace-table";
import { LinkButton } from "@/components/ui/button";
import { PageHeader, Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { getAttention, getOverview, getVolumeSeries, listAdminWorkspaces } from "@/lib/data/admin";
import { first, formatNumber, monthLabel } from "@/lib/format";

export const metadata: Metadata = { title: "Overview" };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default function AdminPage({ searchParams }: { searchParams: SP }) {
  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Overview"
        description="Client workspaces, sending health and limits. Platform admins manage workspaces — message content stays behind explicit mailbox grants."
        actions={<LinkButton href="/admin/new" variant="primary">Add client</LinkButton>}
      />
      <Suspense fallback={<StatsSkeleton />}>
        <Stats />
      </Suspense>
      <div className="mt-6 grid gap-6 lg:grid-cols-5">
        <Panel className="lg:col-span-3">
          <PanelHeader title="Email volume" description="Recipients per month across all workspaces (last 6 months)." />
          <div className="p-5">
            <Suspense fallback={<Skeleton className="h-56 w-full" />}>
              <Volume />
            </Suspense>
          </div>
        </Panel>
        <div className="lg:col-span-2">
          <Suspense fallback={<Skeleton className="h-72 w-full" />}>
            <Attention />
          </Suspense>
        </div>
      </div>
      <div className="mt-6">
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <Workspaces searchParams={searchParams} />
        </Suspense>
      </div>
    </>
  );
}

function StatsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-36" />
      ))}
    </div>
  );
}

async function Stats() {
  const o = await getOverview();
  const rate = o.delivery.rate;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        label="Active workspaces"
        value={formatNumber(o.activeWorkspaces)}
        sub={`${formatNumber(o.totalWorkspaces)} total · ${formatNumber(o.suspendedWorkspaces)} suspended`}
      />
      <StatCard
        label="Verified domains"
        value={formatNumber(o.verifiedDomains)}
        sub={`of ${formatNumber(o.totalDomains)} registered`}
        footnote="Outbound (sending) verification status."
      />
      <StatCard
        label={`Emails submitted · ${monthLabel(o.month)}`}
        value={formatNumber(o.emailsSubmitted)}
        sub={o.emailsReserved ? `${formatNumber(o.emailsReserved)} more reserved in queue` : "Accepted by the email provider"}
        footnote="Sum of settled recipients in monthly_usage for the current UTC month."
      />
      <StatCard
        label="Delivery rate"
        value={rate === null ? "—" : `${(rate * 100).toFixed(1)}%`}
        sub={rate === null ? "No delivery data yet" : `${formatNumber(o.delivery.delivered)} delivered · ${formatNumber(o.delivery.negative)} bounced/failed`}
        footnote="Delivered ÷ (delivered + bounced + complained + failed + suppressed), by recipient, for events this month. In-flight and inbound mail excluded."
      />
    </div>
  );
}

async function Volume() {
  return <VolumeChart data={await getVolumeSeries(6)} />;
}

async function Attention() {
  return <AttentionPanel items={await getAttention()} />;
}

async function Workspaces({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const q = (first(sp.q) ?? "").trim();
  const status = first(sp.status) ?? "all";
  const all = await listAdminWorkspaces();
  const needle = q.toLowerCase();
  const rows = all.filter((w) => {
    if (status !== "all" && w.status !== status) return false;
    if (!needle) return true;
    return (
      w.name.toLowerCase().includes(needle) ||
      w.slug.includes(needle) ||
      w.domains.some((d) => d.hostname.includes(needle))
    );
  });
  return <WorkspaceTable rows={rows} q={q} status={status} totalCount={all.length} />;
}
