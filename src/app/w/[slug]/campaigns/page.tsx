import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Megaphone, Users } from "lucide-react";
import { Suspense } from "react";
import { Badge, type Tone } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, Panel, PanelHeader } from "@/components/ui/panel";
import { SkeletonRows } from "@/components/ui/skeleton";
import { roleAtLeast } from "@/lib/auth/authz";
import { listAudienceLists, listCampaigns } from "@/lib/data/campaigns";
import { getWorkspaceContext } from "@/lib/data/workspace";
import { formatRelative } from "@/lib/format";
import type { CampaignStatus } from "@/lib/types/database";

export const metadata: Metadata = { title: "Campaigns" };

const statusTone: Record<CampaignStatus, Tone> = {
  draft: "neutral",
  scheduled: "accent",
  sending: "warn",
  paused: "warn",
  sent: "success",
  cancelled: "danger",
};

export default function CampaignsPage({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
      <Suspense fallback={<SkeletonRows rows={6} />}>
        <Body params={params} />
      </Suspense>
    </div>
  );
}

async function Body({ params }: { params: Promise<{ slug: string }> }) {
  await connection();
  const { slug } = await params;
  const ctx = await getWorkspaceContext(slug);
  const [campaigns, lists] = await Promise.all([listCampaigns(ctx), listAudienceLists(ctx)]);
  const canAdmin = roleAtLeast(ctx.role, "admin");

  return (
    <div className="space-y-8">
      <PageHeader
        title="Campaigns"
        description="Bulk email from a mailbox you can send from. Each contact becomes one outbound message against your monthly quota."
        actions={
          <div className="flex flex-wrap gap-2">
            <LinkButton href={`/w/${slug}/campaigns/new`} variant="primary">
              <Megaphone className="size-4" aria-hidden /> New campaign
            </LinkButton>
            {canAdmin ? (
              <LinkButton href={`/w/${slug}/campaigns/lists/new`} variant="secondary">
                <Users className="size-4" aria-hidden /> New list
              </LinkButton>
            ) : null}
          </div>
        }
      />

      <Panel>
        <PanelHeader title="Campaigns" description={`${campaigns.length} recent`} />
        {campaigns.length === 0 ? (
          <EmptyState
            icon={Megaphone}
            title="No campaigns yet"
            description="Create an audience list, then send a campaign from a mailbox you can access."
          />
        ) : (
          <ul className="divide-y divide-line">
            {campaigns.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/w/${slug}/campaigns/${c.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 transition-colors hover:bg-surface-muted/60"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{c.name}</p>
                    <p className="mt-0.5 truncate text-[13px] text-muted">
                      {c.listName} · via {c.mailboxAddress} · {formatRelative(c.created_at)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 text-[13px]">
                    <span className="tabular-nums text-muted">
                      {c.sent_count}/{c.total_count || "—"}
                    </span>
                    <Badge tone={statusTone[c.status]}>{c.status}</Badge>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel>
        <PanelHeader title="Audience lists" description={`${lists.length} lists`} />
        {lists.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No lists yet"
            description={canAdmin ? "Create a list and import a CSV of contacts." : "Ask an admin to create an audience list."}
          />
        ) : (
          <ul className="divide-y divide-line">
            {lists.map((l) => (
              <li key={l.id}>
                <Link
                  href={`/w/${slug}/campaigns/lists/${l.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 transition-colors hover:bg-surface-muted/60"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{l.name}</p>
                    {l.description ? <p className="mt-0.5 truncate text-[13px] text-muted">{l.description}</p> : null}
                  </div>
                  <span className="text-[13px] tabular-nums text-muted">{l.contactCount} contacts</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
