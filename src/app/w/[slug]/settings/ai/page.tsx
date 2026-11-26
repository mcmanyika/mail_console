import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { AiSettingsForm } from "@/components/settings/ai-forms";
import { SectionDenied } from "@/components/settings/section-denied";
import { Alert } from "@/components/ui/alert";
import { PageHeader, Panel, PanelHeader } from "@/components/ui/panel";
import { SkeletonRows } from "@/components/ui/skeleton";
import { UsageBar } from "@/components/ui/usage-bar";
import { roleAtLeast } from "@/lib/auth/authz";
import { gateSection, getAiSettings } from "@/lib/data/settings";
import { isOpenAiConfigured } from "@/lib/env";
import { formatNumber, monthLabel } from "@/lib/format";

export const metadata: Metadata = { title: "AI" };

export default function AiSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <>
      <PageHeader title="AI assist" />
      <Suspense fallback={<SkeletonRows rows={5} />}>
        <Body params={params} />
      </Suspense>
    </>
  );
}

async function Body({ params }: { params: Promise<{ slug: string }> }) {
  // currentYearMonth() / Date during render — opt into request time.
  await connection();
  const { slug } = await params;
  const gate = await gateSection(slug, "ai");
  if (!gate.allowed) return <SectionDenied slug={slug} section="AI" />;
  const { ctx } = gate;
  const settings = await getAiSettings(ctx);
  const canEdit = roleAtLeast(ctx.role, "admin");
  const configured = isOpenAiConfigured();

  return (
    <div className="space-y-6">
      {!configured ? (
        <Alert tone="warn" title="OpenAI key not set">
          Add <code className="rounded bg-canvas-deep px-1 font-mono text-xs">OPENAI_API_KEY</code> to the server environment
          (and optionally <code className="rounded bg-canvas-deep px-1 font-mono text-xs">OPENAI_MODEL</code>, default{" "}
          <code className="rounded bg-canvas-deep px-1 font-mono text-xs">gpt-4o-mini</code>), then redeploy. Workspace toggles
          alone will not call the model.
        </Alert>
      ) : null}

      <Panel>
        <PanelHeader
          title={`${monthLabel(settings.month)} usage`}
          description="One request = one summarize, suggest reply, or improve action."
        />
        <div className="p-5">
          <p className="font-serif text-3xl font-semibold tabular-nums text-ink">
            {formatNumber(settings.used)}
            <span className="ml-2 text-base font-normal text-muted">of {formatNumber(settings.monthlyLimit)}</span>
          </p>
          <UsageBar used={settings.used} limit={settings.monthlyLimit} className="mt-4 h-2.5" label="AI usage" />
          <p className="mt-3 text-[13px] text-muted">
            Status: {settings.enabled ? "enabled for this workspace" : "disabled"}
            {!configured ? " · server key missing" : ""}
          </p>
        </div>
      </Panel>

      {canEdit ? (
        <Panel className="p-5">
          <h2 className="mb-4 text-[15px] font-semibold text-ink">Settings</h2>
          <div className="max-w-2xl">
            <AiSettingsForm
              slug={slug}
              enabled={settings.enabled}
              instructions={settings.instructions}
              monthlyLimit={settings.monthlyLimit}
            />
          </div>
        </Panel>
      ) : (
        <p className="rounded-md border border-line bg-surface px-4 py-3 text-[13px] text-muted">
          You can use AI tools in the inbox when an admin enables them. Only owners and admins can change these settings.
        </p>
      )}
    </div>
  );
}
