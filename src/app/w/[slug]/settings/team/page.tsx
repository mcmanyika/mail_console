import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { InviteMemberForm, RoleSelect } from "@/components/settings/team-forms";
import { SectionDenied } from "@/components/settings/section-denied";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-dialog";
import { PageHeader, Panel, PanelHeader } from "@/components/ui/panel";
import { SkeletonRows } from "@/components/ui/skeleton";
import { SubmitButton } from "@/components/ui/submit-button";
import { removeMemberAction, revokeInvitationAction } from "@/lib/actions/settings";
import { canManageRole } from "@/lib/auth/authz";
import { gateSection, getMembers, getPendingInvitations } from "@/lib/data/settings";
import { formatRelative } from "@/lib/format";
import type { WorkspaceRole } from "@/lib/types/database";

export const metadata: Metadata = { title: "Team" };

export default function TeamPage({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <>
      <PageHeader title="Team" description="Who belongs to this workspace and what they can manage. Every workspace keeps at least one owner." />
      <Suspense fallback={<SkeletonRows rows={5} />}>
        <Body params={params} />
      </Suspense>
    </>
  );
}

async function Body({ params }: { params: Promise<{ slug: string }> }) {
  // Invite expiry / "joined" relative times — opt into request time.
  await connection();
  const { slug } = await params;
  const gate = await gateSection(slug, "team");
  if (!gate.allowed) return <SectionDenied slug={slug} section="Team" />;
  const { ctx } = gate;
  const [members, invites] = await Promise.all([getMembers(ctx.workspace.id), getPendingInvitations(ctx)]);
  const owners = members.filter((m) => m.role === "owner").length;
  const allRoles: WorkspaceRole[] = ["owner", "admin", "member"];

  return (
    <div className="space-y-6">
      <Panel className="p-5">
        <h2 className="mb-4 text-[15px] font-semibold text-ink">Invite someone</h2>
        <InviteMemberForm slug={slug} canInviteAdmin={canManageRole(ctx.role, "admin")} />
      </Panel>

      <Panel>
        <PanelHeader title="Members" description={`${members.length} in this workspace`} />
        <ul className="divide-y divide-line">
          {members.map((m) => {
            const self = m.userId === ctx.user.id;
            const lastOwner = m.role === "owner" && owners <= 1;
            const manageable = canManageRole(ctx.role, m.role);
            const roleOptions = allRoles.filter((r) => canManageRole(ctx.role, r));
            if (!roleOptions.includes(m.role)) roleOptions.unshift(m.role);
            const lockReason = lastOwner
              ? "This is the only owner. Promote someone else first."
              : !manageable
                ? "Only owners can change an owner."
                : undefined;
            return (
              <li key={m.membershipId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">
                    {m.fullName ?? m.email}
                    {self ? <span className="ml-1.5 text-xs font-normal text-muted">(you)</span> : null}
                  </p>
                  {m.fullName ? <p className="truncate text-xs text-muted">{m.email}</p> : null}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {lastOwner ? <Badge tone="accent">Only owner</Badge> : null}
                  <RoleSelect
                    slug={slug}
                    membershipId={m.membershipId}
                    role={m.role}
                    options={roleOptions}
                    disabled={!manageable || lastOwner}
                    reason={lockReason}
                  />
                  {!self && manageable && !lastOwner ? (
                    <ConfirmButton
                      action={removeMemberAction}
                      hiddenFields={{ slug, membershipId: m.membershipId }}
                      triggerLabel="Remove"
                      triggerSize="sm"
                      title={`Remove ${m.fullName ?? m.email}?`}
                      confirmLabel="Remove member"
                      description="They lose access to this workspace immediately, including every mailbox grant they hold. Their past sent messages stay in the mailboxes."
                    />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </Panel>

      {invites.length ? (
        <Panel>
          <PanelHeader title="Pending invitations" description="Links are single-use. Revoke to invalidate one." />
          <ul className="divide-y divide-line">
            {invites.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                <div>
                  <p className="font-medium text-ink">{i.email}</p>
                  <p className="text-xs text-muted">
                    Invited {formatRelative(i.created_at)} · expires {new Date(i.expires_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge tone="neutral">{i.role}</Badge>
                  <form action={revokeInvitationAction.bind(null, slug, i.id)}>
                    <SubmitButton variant="ghost" size="sm" pendingLabel="…">
                      Revoke
                    </SubmitButton>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
