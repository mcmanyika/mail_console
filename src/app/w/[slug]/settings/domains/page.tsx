import type { Metadata } from "next";
import { Globe } from "lucide-react";
import { connection } from "next/server";
import { Suspense } from "react";
import { DomainCard } from "@/components/settings/domain-card";
import { AddDomainForm } from "@/components/settings/domain-forms";
import { SectionDenied } from "@/components/settings/section-denied";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, Panel } from "@/components/ui/panel";
import { SkeletonRows } from "@/components/ui/skeleton";
import { gateSection, getDomainMailboxCounts, getDomains } from "@/lib/data/settings";
import { isDemoMode } from "@/lib/env";

export const metadata: Metadata = { title: "Domains" };

export default function DomainsPage({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <>
      <PageHeader title="Domains" description="Where your workspace sends from and receives at. Sending and receiving are verified separately." />
      <Suspense fallback={<SkeletonRows rows={4} />}>
        <Body params={params} />
      </Suspense>
    </>
  );
}

async function Body({ params }: { params: Promise<{ slug: string }> }) {
  // "Last checked" uses formatRelative / Date — opt into request time.
  await connection();
  const { slug } = await params;
  const gate = await gateSection(slug, "domains");
  if (!gate.allowed) return <SectionDenied slug={slug} section="Domain" />;
  const [domains, mailboxCounts] = await Promise.all([
    getDomains(gate.ctx),
    getDomainMailboxCounts(gate.ctx.workspace.id),
  ]);
  return (
    <div className="space-y-6">
      {isDemoMode() ? (
        <Alert tone="info" title="Demo mode">
          Domains are simulated and no email leaves this machine. Records below are placeholders.
        </Alert>
      ) : null}
      <Panel className="p-5">
        <h2 className="mb-3 text-[15px] font-semibold text-ink">Add a domain</h2>
        <AddDomainForm workspaceId={gate.ctx.workspace.id} />
      </Panel>
      {domains.length === 0 ? (
        <Panel>
          <EmptyState icon={Globe} title="No domains yet" description="Add a subdomain like mail.example.com. You'll get DNS records to publish with your DNS host." />
        </Panel>
      ) : (
        <div className="space-y-4">
          {domains.map((d) => (
            <DomainCard key={d.id} domain={d} mailboxCount={mailboxCounts[d.id] ?? 0} />
          ))}
        </div>
      )}
    </div>
  );
}
