import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Badge, type Tone } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-dialog";
import { LinkButton } from "@/components/ui/button";
import { PageHeader, Panel, PanelHeader } from "@/components/ui/panel";
import { SkeletonRows } from "@/components/ui/skeleton";
import { UsageBar } from "@/components/ui/usage-bar";
import { cancelCampaignAction, resumeCampaignAction, startCampaignAction } from "@/lib/actions/campaigns";
import { getCampaign } from "@/lib/data/campaigns";
import { getWorkspaceContext } from "@/lib/data/workspace";
import { formatFullDate, formatRelative } from "@/lib/format";
import type { CampaignStatus } from "@/lib/types/database";

export const metadata: Metadata = { title: "Campaign" };

const statusTone: Record<CampaignStatus, Tone> = {
  draft: "neutral",
  scheduled: "accent",
  sending: "warn",
  paused: "warn",
  sent: "success",
  cancelled: "danger",
};

export default function CampaignDetailPage({ params }: { params: Promise<{ slug: string; campaignId: string }> }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
      <Suspense fallback={<SkeletonRows rows={8} />}>
        <Body params={params} />
      </Suspense>
    </div>
  );
}

async function Body({ params }: { params: Promise<{ slug: string; campaignId: string }> }) {
  await connection();
  const { slug, campaignId } = await params;
  const ctx = await getWorkspaceContext(slug);
  const detail = await getCampaign(ctx, campaignId);
  if (!detail) notFound();
  const { campaign, listName, mailboxAddress, recipients, canSend } = detail;
  const processed = campaign.sent_count + campaign.failed_count + campaign.skipped_count;
  const total = campaign.total_count || processed;

  return (
    <div className="space-y-6">
      <PageHeader
        title={campaign.name}
        description={
          <>
            {listName} · via {mailboxAddress} · created {formatRelative(campaign.created_at)}
          </>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone[campaign.status]}>{campaign.status}</Badge>
            <LinkButton href={`/w/${slug}/campaigns`} variant="secondary">
              Back
            </LinkButton>
            {canSend && campaign.status === "draft" ? (
              <ConfirmButton
                action={startCampaignAction.bind(null, slug, campaign.id)}
                triggerLabel="Start sending"
                title={`Send to everyone on “${listName}”?`}
                description="Each contact is queued individually against your monthly sending quota. You can cancel remaining sends later."
                confirmLabel="Start campaign"
              />
            ) : null}
            {canSend && campaign.status === "paused" ? (
              <ConfirmButton
                action={resumeCampaignAction.bind(null, slug, campaign.id)}
                triggerLabel="Resume"
                title="Resume this campaign?"
                description="Continues queuing remaining contacts. If you hit the monthly limit again, it will pause."
                confirmLabel="Resume"
              />
            ) : null}
            {canSend && ["draft", "scheduled", "sending", "paused"].includes(campaign.status) ? (
              <ConfirmButton
                action={cancelCampaignAction.bind(null, slug, campaign.id)}
                triggerLabel="Cancel"
                triggerVariant="danger-ghost"
                title="Cancel this campaign?"
                description="Unsent recipients will be dropped. Already queued messages may still go out."
                confirmLabel="Cancel campaign"
              />
            ) : null}
          </div>
        }
      />

      <Panel>
        <PanelHeader title="Progress" />
        <div className="space-y-4 p-5">
          <UsageBar used={processed} limit={Math.max(total, 1)} className="h-2.5" label="Campaign progress" />
          <dl className="grid gap-4 text-sm sm:grid-cols-4">
            <Stat label="Total" value={campaign.total_count} />
            <Stat label="Queued / sent" value={campaign.sent_count} />
            <Stat label="Failed" value={campaign.failed_count} />
            <Stat label="Skipped" value={campaign.skipped_count} />
          </dl>
          {campaign.scheduled_at ? (
            <p className="text-[13px] text-muted">Scheduled for {formatFullDate(campaign.scheduled_at)}</p>
          ) : null}
          {campaign.status === "paused" ? (
            <p className="text-[13px] text-warn">Paused — usually because the monthly sending quota was hit. Resume after quota frees up.</p>
          ) : null}
          {campaign.status === "sending" ? (
            <p className="text-[13px] text-muted">Sending runs via the outbox cron (about once a minute). Refresh to see progress.</p>
          ) : null}
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Content" />
        <div className="space-y-3 p-5">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Subject</p>
            <p className="mt-1 text-sm text-ink">{campaign.subject}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Body</p>
            <pre className="mt-1 whitespace-pre-wrap rounded-md border border-line bg-surface-muted/40 p-3 text-[13px] leading-relaxed text-ink-2">
              {campaign.body_text}
            </pre>
          </div>
        </div>
      </Panel>

      {recipients.length ? (
        <Panel>
          <PanelHeader title="Recipients" description={`${recipients.length}${recipients.length >= 200 ? "+" : ""} shown`} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-left text-[13px]">
              <thead className="border-b border-line bg-surface-muted/50 text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Email</th>
                  <th className="px-5 py-2.5 font-medium">Status</th>
                  <th className="px-5 py-2.5 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {recipients.map((r) => (
                  <tr key={r.id}>
                    <td className="px-5 py-2.5 font-medium text-ink">{r.email}</td>
                    <td className="px-5 py-2.5 capitalize text-ink-2">{r.status}</td>
                    <td className="max-w-sm truncate px-5 py-2.5 text-muted">{r.error ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="font-serif text-xl font-semibold tabular-nums text-ink">{value}</dd>
    </div>
  );
}
