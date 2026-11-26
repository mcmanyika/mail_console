import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ImportContactsForm } from "@/components/campaigns/campaign-forms";
import { ConfirmButton } from "@/components/ui/confirm-dialog";
import { LinkButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, Panel, PanelHeader } from "@/components/ui/panel";
import { SkeletonRows } from "@/components/ui/skeleton";
import { deleteAudienceListAction, deleteContactAction } from "@/lib/actions/campaigns";
import { roleAtLeast } from "@/lib/auth/authz";
import { getPlan } from "@/lib/billing/plans";
import { getAudienceList } from "@/lib/data/campaigns";
import { getWorkspaceContext } from "@/lib/data/workspace";
import { contactLimitForWorkspacePlan } from "@/lib/email/campaigns";
import { Users } from "lucide-react";

export const metadata: Metadata = { title: "Audience list" };

export default function ListDetailPage({ params }: { params: Promise<{ slug: string; listId: string }> }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
      <Suspense fallback={<SkeletonRows rows={8} />}>
        <Body params={params} />
      </Suspense>
    </div>
  );
}

async function Body({ params }: { params: Promise<{ slug: string; listId: string }> }) {
  await connection();
  const { slug, listId } = await params;
  const ctx = await getWorkspaceContext(slug);
  const detail = await getAudienceList(ctx, listId);
  if (!detail) notFound();
  const canAdmin = roleAtLeast(ctx.role, "admin");
  const { list, contacts } = detail;
  const contactLimit = contactLimitForWorkspacePlan(ctx.workspace.plan);
  const planName = getPlan(ctx.workspace.plan)?.name ?? "Custom";

  return (
    <div className="space-y-6">
      <PageHeader
        title={list.name}
        description={list.description || "Audience list"}
        actions={
          <div className="flex flex-wrap gap-2">
            <LinkButton href={`/w/${slug}/campaigns/new`} variant="primary">
              Use in campaign
            </LinkButton>
            <LinkButton href={`/w/${slug}/campaigns`} variant="secondary">
              Back
            </LinkButton>
            {canAdmin ? (
              <ConfirmButton
                action={deleteAudienceListAction.bind(null, slug, list.id)}
                triggerLabel="Delete list"
                triggerVariant="danger-ghost"
                title={`Delete “${list.name}”?`}
                confirmLabel="Delete list"
                description="Contacts on this list will be removed. Campaigns that used it cannot be deleted this way if still referenced."
              />
            ) : null}
          </div>
        }
      />

      {canAdmin ? (
        <Panel className="p-5">
          <h2 className="mb-4 text-[15px] font-semibold text-ink">Import contacts</h2>
          <div className="max-w-2xl">
            <ImportContactsForm slug={slug} listId={list.id} contactLimit={contactLimit} planName={planName} />
          </div>
        </Panel>
      ) : null}

      <Panel>
        <PanelHeader title="Contacts" description={`${contacts.length}${contacts.length >= 500 ? "+" : ""} shown`} />
        {contacts.length === 0 ? (
          <EmptyState icon={Users} title="No contacts yet" description="Import a CSV with an email column." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-[13px]">
              <thead className="border-b border-line bg-surface-muted/50 text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Email</th>
                  <th className="px-5 py-2.5 font-medium">Name</th>
                  <th className="px-5 py-2.5 font-medium">Fields</th>
                  {canAdmin ? <th className="px-5 py-2.5 font-medium" /> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {contacts.map((c) => {
                  const fields =
                    c.fields && typeof c.fields === "object" && !Array.isArray(c.fields)
                      ? Object.entries(c.fields as Record<string, unknown>)
                          .filter(([k]) => k !== "first_name")
                          .map(([k, v]) => `${k}=${String(v)}`)
                          .join(", ")
                      : "";
                  return (
                    <tr key={c.id}>
                      <td className="px-5 py-2.5 font-medium text-ink">{c.email}</td>
                      <td className="px-5 py-2.5 text-ink-2">{c.full_name ?? "—"}</td>
                      <td className="max-w-xs truncate px-5 py-2.5 text-muted">{fields || "—"}</td>
                      {canAdmin ? (
                        <td className="px-5 py-2.5 text-right">
                          <ConfirmButton
                            action={deleteContactAction.bind(null, slug, list.id, c.id)}
                            triggerLabel="Remove"
                            triggerSize="sm"
                            triggerVariant="danger-ghost"
                            title={`Remove ${c.email}?`}
                            description="They will no longer be included in new campaigns from this list."
                            confirmLabel="Remove"
                          />
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
