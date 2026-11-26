import type { Metadata } from "next";
import { KeyRound } from "lucide-react";
import { connection } from "next/server";
import { Suspense } from "react";
import { CreateIntegrationForm } from "@/components/settings/integration-forms";
import { SectionDenied } from "@/components/settings/section-denied";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, Panel, PanelHeader } from "@/components/ui/panel";
import { SkeletonRows } from "@/components/ui/skeleton";
import { revokeIntegrationAction } from "@/lib/actions/settings";
import { gateSection, getIntegrations, getMailboxAdminData } from "@/lib/data/settings";
import { MAX_RECIPIENTS_PER_MESSAGE } from "@/lib/email/quota";
import { formatRelative } from "@/lib/format";

export const metadata: Metadata = { title: "Integrations" };

export default function IntegrationsPage({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <>
      <PageHeader title="Integrations" description="API keys that let your own apps send transactional email through this workspace." />
      <Suspense fallback={<SkeletonRows rows={4} />}>
        <Body params={params} />
      </Suspense>
    </>
  );
}

async function Body({ params }: { params: Promise<{ slug: string }> }) {
  await connection();
  const { slug } = await params;
  const gate = await gateSection(slug, "integrations");
  if (!gate.allowed) return <SectionDenied slug={slug} section="Integration" />;
  const { ctx } = gate;
  const [keys, mb] = await Promise.all([getIntegrations(ctx), getMailboxAdminData(ctx.workspace.id)]);
  const mailboxName = new Map(mb.mailboxes.map((m) => [m.id, m.address]));

  return (
    <div className="space-y-6">
      <Panel className="p-5">
        <h2 className="mb-4 text-[15px] font-semibold text-ink">Create an API key</h2>
        <CreateIntegrationForm slug={slug} mailboxes={mb.mailboxes.filter((m) => m.enabled).map((m) => ({ id: m.id, address: m.address }))} />
      </Panel>

      <Panel>
        <PanelHeader title="Keys" description="Only a hash is stored; full keys can't be shown again." />
        {keys.length === 0 ? (
          <EmptyState icon={KeyRound} title="No API keys yet" description="Create one above to send from your own application." />
        ) : (
          <ul className="divide-y divide-line">
            {keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                    {k.name}
                    {k.revoked_at ? <Badge tone="danger">Revoked</Badge> : <Badge tone="success" dot>Active</Badge>}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    <code className="font-mono text-ink-2">{k.key_prefix}…</code> · {k.allowed_mailbox_id ? `only ${mailboxName.get(k.allowed_mailbox_id) ?? "one mailbox"}` : "any mailbox"} · last used{" "}
                    {k.last_used_at ? formatRelative(k.last_used_at) : "never"}
                  </p>
                </div>
                {!k.revoked_at ? (
                  <ConfirmButton
                    action={revokeIntegrationAction.bind(null, slug, k.id)}
                    triggerLabel="Revoke"
                    triggerSize="sm"
                    title={`Revoke “${k.name}”?`}
                    confirmLabel="Revoke key"
                    description="Apps using this key will start receiving 401 errors immediately. This can't be undone."
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Alert tone="info" title="Limits & behaviour">
        <ul className="list-disc space-y-1 pl-4">
          <li>Authenticate with <code className="font-mono text-xs">Authorization: Bearer &lt;key&gt;</code>. Keys are workspace-scoped, optionally pinned to a single mailbox.</li>
          <li>API sends share your workspace&apos;s monthly limit with people sending from the inbox — one unit per unique recipient.</li>
          <li>At most {MAX_RECIPIENTS_PER_MESSAGE} recipients per message. Requests over the monthly limit are refused, and failed sends release their reservation.</li>
          <li>Transient provider errors are retried automatically with backoff; send an idempotency key to make retries safe.</li>
          <li>Suspended workspaces reject API requests (inbound mail is still received).</li>
        </ul>
      </Alert>
    </div>
  );
}
