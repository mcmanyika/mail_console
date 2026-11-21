import type { Metadata } from "next";
import { Mail } from "lucide-react";
import { Suspense } from "react";
import { CreateMailboxForm, GrantRow } from "@/components/settings/mailbox-forms";
import { SectionDenied } from "@/components/settings/section-denied";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, Panel } from "@/components/ui/panel";
import { SkeletonRows } from "@/components/ui/skeleton";
import { SubmitButton } from "@/components/ui/submit-button";
import { toggleMailboxAction } from "@/lib/actions/settings";
import { canManageRole } from "@/lib/auth/authz";
import { gateSection, getMailboxAdminData } from "@/lib/data/settings";
import { LinkButton } from "@/components/ui/button";

export const metadata: Metadata = { title: "Mailboxes" };

export default function MailboxesPage({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <>
      <PageHeader
        title="Mailboxes"
        description="Addresses on your domains, and who may read or send from each. Access is always explicit — including for owners and admins."
      />
      <Suspense fallback={<SkeletonRows rows={5} />}>
        <Body params={params} />
      </Suspense>
    </>
  );
}

async function Body({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const gate = await gateSection(slug, "mailboxes");
  if (!gate.allowed) return <SectionDenied slug={slug} section="Mailbox" />;
  const { ctx } = gate;
  const { mailboxes, members, domains } = await getMailboxAdminData(ctx.workspace.id);

  return (
    <div className="space-y-6">
      <Alert tone="info" title="Managing access is not the same as having access">
        You can see mailbox names and change grants here, but you can only read a mailbox&apos;s messages after you&apos;ve been
        granted access to it. Every grant change is written to the audit log.
      </Alert>

      <Panel className="p-5">
        <h2 className="mb-4 text-[15px] font-semibold text-ink">Create a mailbox</h2>
        {domains.length === 0 ? (
          <EmptyState
            className="py-6"
            icon={Mail}
            title="Add a domain first"
            description="Mailboxes live on a verified domain."
            action={<LinkButton href={`/w/${slug}/settings/domains`} variant="secondary">Go to domains</LinkButton>}
          />
        ) : (
          <CreateMailboxForm slug={slug} domains={domains} />
        )}
      </Panel>

      {mailboxes.length === 0 ? null : (
        <div className="space-y-4">
          {mailboxes.map((mb) => (
            <section key={mb.id} className="overflow-hidden rounded-lg border border-line bg-surface shadow-(--shadow-panel)" aria-label={mb.address}>
              <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
                <div className="min-w-0">
                  <h3 className="truncate font-mono text-[15px] font-medium text-ink">{mb.address}</h3>
                  <p className="text-xs text-muted">{mb.displayName ?? "No display name"}</p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge tone={mb.enabled ? "success" : "neutral"} dot>
                    {mb.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                  <form action={toggleMailboxAction.bind(null, slug, mb.id, !mb.enabled)}>
                    <SubmitButton variant="secondary" size="sm">
                      {mb.enabled ? "Disable" : "Enable"}
                    </SubmitButton>
                  </form>
                </div>
              </header>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-muted">
                    <th className="px-5 py-2 font-medium">Member</th>
                    <th className="px-2 py-2 font-medium">Role</th>
                    <th className="px-5 py-2 text-right font-medium">Mailbox access</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {members.map((m) => {
                    const self = m.userId === ctx.user.id;
                    const locked = !self && !canManageRole(ctx.role, m.role);
                    return (
                      <tr key={m.membershipId}>
                        <td className="px-5 py-2.5">
                          <span className="block font-medium text-ink">{m.fullName ?? m.email}{self ? <span className="ml-1.5 text-xs font-normal text-muted">(you)</span> : null}</span>
                          {m.fullName ? <span className="block text-xs text-muted">{m.email}</span> : null}
                        </td>
                        <td className="px-2 py-2.5">
                          <Badge tone={m.role === "owner" ? "accent" : "neutral"}>{m.role}</Badge>
                        </td>
                        <td className="px-5 py-2.5">
                          <GrantRow
                            slug={slug}
                            mailboxId={mb.id}
                            membershipId={m.membershipId}
                            current={mb.grants[m.membershipId] ?? "none"}
                            disabled={locked}
                            disabledReason={locked ? "Only owners can change an owner's access" : undefined}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
