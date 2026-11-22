import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { InviteOwnerForm, SuspendControls, UpdateLimitForm } from "@/components/admin/workspace-forms";
import { VolumeChart } from "@/components/admin/volume-chart";
import { AddDomainForm } from "@/components/settings/domain-forms";
import { DomainCard } from "@/components/settings/domain-card";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, Panel, PanelHeader } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { UsageBar } from "@/components/ui/usage-bar";
import { SubmitButton } from "@/components/ui/submit-button";
import { revokeInvitationAdminAction } from "@/lib/actions/admin";
import { getAdminWorkspaceDetail } from "@/lib/data/admin";
import { getDomainMailboxCounts } from "@/lib/data/settings";
import { formatNumber, formatRelative } from "@/lib/format";
import { Globe } from "lucide-react";

export const metadata: Metadata = { title: "Workspace" };

export default function AdminWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <>
      <Link href="/admin" className="mb-4 inline-block text-[13px] text-muted hover:text-ink">
        ← Overview
      </Link>
      <Suspense fallback={<Skeleton className="h-[32rem] w-full" />}>
        <Detail params={params} />
      </Suspense>
    </>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function Detail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const d = await getAdminWorkspaceDetail(id);
  if (!d) notFound();
  const mailboxCounts = await getDomainMailboxCounts(id);
  const { workspace: w } = d;
  const suspended = w.status === "suspended";

  return (
    <>
      <PageHeader
        eyebrow={<span className="font-mono normal-case">/w/{w.slug}</span>}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {w.name}
            <Badge tone={suspended ? "danger" : w.status === "active" ? "success" : "warn"}>{w.status}</Badge>
          </span>
        }
        description="Platform view. You can manage status, limits, invitations and domains here; message content is not visible to platform admins."
        actions={<SuspendControls workspaceId={w.id} name={w.name} status={w.status} />}
      />

      {suspended ? (
        <Alert tone="danger" title="Workspace suspended" className="mb-6">
          Outbound sending and the transactional API are stopped. Inbound mail is still being received and stored.
        </Alert>
      ) : null}
      {d.members.length === 0 ? (
        <Alert tone="warn" title="No members yet" className="mb-6">
          Invite the owner below, then set up a domain. Until someone accepts, nobody can use this workspace.
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <Panel>
          <PanelHeader title="This month" description={`UTC ${d.quota.yearMonth}`} />
          <div className="space-y-4 p-5">
            <div>
              <p className="font-serif text-3xl font-semibold tabular-nums text-ink">
                {formatNumber(d.quota.settled + d.quota.reserved)}
                <span className="ml-1.5 text-base font-normal text-muted">/ {formatNumber(d.quota.limit)}</span>
              </p>
              <UsageBar used={d.quota.settled + d.quota.reserved} limit={d.quota.limit} className="mt-3" label="Monthly usage" />
              <p className="mt-2 text-xs text-muted">
                {formatNumber(d.quota.settled)} submitted · {formatNumber(d.quota.reserved)} reserved · {formatNumber(d.quota.remaining)} remaining
              </p>
            </div>
            <UpdateLimitForm workspaceId={w.id} limit={w.monthly_sending_limit} />
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Queue health" description="Outbound jobs for this workspace" />
          <dl className="grid grid-cols-2 gap-px bg-line text-sm">
            {(["pending", "processing", "succeeded", "failed", "dead"] as const).map((s) => (
              <div key={s} className="bg-surface px-5 py-3">
                <dt className="text-xs capitalize text-muted">{s}</dt>
                <dd className={`font-serif text-xl font-semibold tabular-nums ${(s === "failed" || s === "dead") && d.outbox[s] > 0 ? "text-danger" : "text-ink"}`}>
                  {formatNumber(d.outbox[s])}
                </dd>
              </div>
            ))}
            <div className="bg-surface px-5 py-3">
              <dt className="text-xs text-muted">Mailboxes</dt>
              <dd className="font-serif text-xl font-semibold tabular-nums text-ink">{formatNumber(d.mailboxCount)}</dd>
            </div>
          </dl>
        </Panel>

        <Panel>
          <PanelHeader title="Owner & invitations" />
          <div className="space-y-4 p-5">
            <InviteOwnerForm workspaceId={w.id} hasOwner={d.hasOwner} />
            {d.invitations.length ? (
              <ul className="divide-y divide-line rounded-md border border-line">
                {d.invitations.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-2 px-3 py-2 text-[13px]">
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-ink">{i.email}</span>
                      <span className="text-xs text-muted">expires {formatRelative(i.expiresAt).replace(" ago", " ago")}</span>
                    </span>
                    <form action={revokeInvitationAdminAction}>
                      <input type="hidden" name="invitationId" value={i.id} />
                      <input type="hidden" name="workspaceId" value={w.id} />
                      <SubmitButton variant="ghost" size="sm" pendingLabel="…">
                        Revoke
                      </SubmitButton>
                    </form>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </Panel>
      </div>

      <section id="domains" className="mt-8 scroll-mt-20">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-serif text-xl font-semibold text-ink">Domains</h2>
            <p className="text-[13px] text-muted">Add the client&apos;s sending domain and hand them these DNS records.</p>
          </div>
        </div>
        <Panel className="mb-4 p-5">
          <AddDomainForm workspaceId={w.id} />
        </Panel>
        {d.domains.length === 0 ? (
          <Panel>
            <EmptyState icon={Globe} title="No domains yet" description="Add a subdomain like mail.client.com above to get DNS records." />
          </Panel>
        ) : (
          <div className="space-y-4">
            {d.domains.map((dom) => (
              <DomainCard key={dom.id} domain={dom} mailboxCount={mailboxCounts[dom.id] ?? 0} />
            ))}
          </div>
        )}
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Members" description="Roles only. Mail access is granted per mailbox by the workspace." />
          {d.members.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted">Nobody has joined yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {d.members.map((m) => (
                <li key={m.membershipId} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-ink">{m.fullName ?? m.email}</span>
                    {m.fullName ? <span className="block truncate text-xs text-muted">{m.email}</span> : null}
                  </span>
                  <Badge tone={m.role === "owner" ? "accent" : "neutral"}>{m.role}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel>
          <PanelHeader title="Volume" description="Last 6 months" />
          <div className="p-5">
            <VolumeChart data={d.history} />
          </div>
        </Panel>
      </div>

      <Panel className="mt-6">
        <PanelHeader title="Recent activity" description="Audit log (no message content is ever recorded)." />
        {d.audit.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">No activity yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {d.audit.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-[13px]">
                <span>
                  <code className="rounded bg-canvas-deep px-1.5 py-0.5 font-mono text-xs text-ink">{a.action}</code>
                  <span className="ml-2 text-muted">{a.actor ?? "system"}</span>
                </span>
                <span className="text-xs text-muted">{formatRelative(a.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
