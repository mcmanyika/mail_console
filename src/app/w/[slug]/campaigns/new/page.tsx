import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { CreateCampaignForm } from "@/components/campaigns/campaign-forms";
import { Alert } from "@/components/ui/alert";
import { LinkButton } from "@/components/ui/button";
import { PageHeader, Panel } from "@/components/ui/panel";
import { SkeletonRows } from "@/components/ui/skeleton";
import { getPlan } from "@/lib/billing/plans";
import { getCampaignFormOptions } from "@/lib/data/campaigns";
import { getWorkspaceContext } from "@/lib/data/workspace";
import { contactLimitForWorkspacePlan } from "@/lib/email/campaigns";
import { getQuotaStatus } from "@/lib/email/quota";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata: Metadata = { title: "New campaign" };

export default function NewCampaignPage({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8 md:py-8">
      <PageHeader title="New campaign" description="One message per contact, sent through your existing outbox and quota." />
      <Suspense fallback={<SkeletonRows rows={8} />}>
        <Body params={params} />
      </Suspense>
    </div>
  );
}

async function Body({ params }: { params: Promise<{ slug: string }> }) {
  await connection();
  const { slug } = await params;
  const ctx = await getWorkspaceContext(slug);
  const [{ lists, sendMailboxes, templates }, quota] = await Promise.all([
    getCampaignFormOptions(slug),
    getQuotaStatus(createAdminClient(), ctx.workspace.id),
  ]);
  const contactLimit = contactLimitForWorkspacePlan(ctx.workspace.plan);
  const planName = getPlan(ctx.workspace.plan)?.name ?? "Custom";

  if (!lists.length) {
    return (
      <Alert tone="warn" title="Create a list first">
        Import contacts before composing a campaign.{" "}
        <LinkButton href={`/w/${slug}/campaigns/lists/new`} variant="secondary" className="ml-1 inline-flex">
          New list
        </LinkButton>
      </Alert>
    );
  }
  if (!sendMailboxes.length) {
    return (
      <Alert tone="warn" title="No send access">
        You need send access on at least one mailbox to start a campaign. Ask a workspace admin for a grant.
      </Alert>
    );
  }

  return (
    <Panel className="p-5">
      <CreateCampaignForm
        slug={slug}
        lists={lists.map((l) => ({ id: l.id, name: l.name, contactCount: l.contactCount }))}
        mailboxes={sendMailboxes.map((m) => ({
          id: m.id,
          label: m.displayName ? `${m.displayName} <${m.address}>` : m.address,
        }))}
        templates={(templates ?? []).map((t) => ({
          id: t.id,
          name: t.name,
          subject: t.subject,
          body: t.body_text ?? "",
        }))}
        contactLimit={contactLimit}
        planName={planName}
        sendsRemaining={quota.remaining}
        monthlySendLimit={quota.limit}
      />
    </Panel>
  );
}
