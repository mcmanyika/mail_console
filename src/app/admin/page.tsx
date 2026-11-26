import type { Metadata } from "next";
import { Suspense } from "react";
import { AttentionPanel } from "@/components/admin/attention-panel";
import { StatCard } from "@/components/admin/stat-card";
import { VolumeChart } from "@/components/admin/volume-chart";
import { WorkspaceTable } from "@/components/admin/workspace-table";
import { LinkButton } from "@/components/ui/button";
import { PageHeader, Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { getAttention, getOverview, getVolumeSeries, listAdminUsers, listAdminWorkspaces } from "@/lib/data/admin";
import { first, formatNumber, monthLabel } from "@/lib/format";

export const metadata: Metadata = { title: "Overview" };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default function AdminPage({ searchParams }: { searchParams: SP }) {
  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Overview"
        actions={
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/admin/users" variant="secondary">
              Users
            </LinkButton>
            <LinkButton href="/admin/new" variant="primary">
              Add client
            </LinkButton>
          </div>
        }
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
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-52" />
      ))}
    </div>
  );
}

async function Stats() {
  const [o, users] = await Promise.all([getOverview(), listAdminUsers()]);
  const rate = o.delivery.rate;
  const withWorkspace = users.filter((u) => u.memberships.length > 0).length;
  const userRatio = users.length > 0 ? withWorkspace / users.length : null;
  const workspaceRatio = o.totalWorkspaces > 0 ? o.activeWorkspaces / o.totalWorkspaces : null;
  const domainRatio = o.totalDomains > 0 ? o.verifiedDomains / o.totalDomains : null;
  const queued = o.emailsSubmitted + o.emailsReserved;
  const submitRatio = queued > 0 ? o.emailsSubmitted / queued : o.emailsSubmitted > 0 ? 1 : null;

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      <StatCard
        label="Registered users"
        value={formatNumber(users.length)}
        gauge={userRatio}
        sub={`${formatNumber(withWorkspace)} in a workspace`}
      />
      <StatCard
        label="Active workspaces"
        value={formatNumber(o.activeWorkspaces)}
        gauge={workspaceRatio}
        sub={`${formatNumber(o.totalWorkspaces)} total · ${formatNumber(o.suspendedWorkspaces)} suspended`}
      />
      <StatCard
        label="Verified domains"
        value={formatNumber(o.verifiedDomains)}
        gauge={domainRatio}
        sub={`of ${formatNumber(o.totalDomains)} registered`}
      />
      <StatCard
        label={`Emails submitted · ${monthLabel(o.month)}`}
        value={formatNumber(o.emailsSubmitted)}
        gauge={submitRatio}
        sub={o.emailsReserved ? `${formatNumber(o.emailsReserved)} more reserved in queue` : "Accepted by the email provider"}
      />
      <StatCard
        label="Delivery rate"
        value={rate === null ? "—" : `${(rate * 100).toFixed(1)}%`}
        gauge={rate}
        sub={rate === null ? "No delivery data yet" : `${formatNumber(o.delivery.delivered)} delivered · ${formatNumber(o.delivery.negative)} bounced/failed`}
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
