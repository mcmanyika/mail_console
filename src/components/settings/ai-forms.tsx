"use client";

import { saveAiSettingsAction } from "@/lib/actions/settings";
import { ActionField, ActionForm } from "@/components/ui/action-form";
import { Input, Textarea } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";

export function AiSettingsForm({
  slug,
  enabled,
  instructions,
  monthlyLimit,
}: {
  slug: string;
  enabled: boolean;
  instructions: string;
  monthlyLimit: number;
}) {
  return (
    <ActionForm action={saveAiSettingsAction}>
      <input type="hidden" name="slug" value={slug} />
      <label className="flex items-start gap-3 rounded-md border border-line bg-surface px-3.5 py-3 text-sm">
        <input type="checkbox" name="aiEnabled" defaultChecked={enabled} className="mt-0.5 size-4 accent-[#4F46E5]" />
        <span>
          <span className="font-medium text-ink">Enable AI assist</span>
          <span className="mt-0.5 block text-[13px] text-muted">
            Members with mailbox access can summarize threads and draft or improve replies. Requires{" "}
            <code className="rounded bg-canvas-deep px-1 font-mono text-xs">OPENAI_API_KEY</code> on the server.
          </span>
        </span>
      </label>
      <ActionField
        label="Workspace guidance"
        name="aiInstructions"
        hint="Optional tone and context (e.g. brand voice). Shared for this workspace only — never across clients."
      >
        <Textarea
          id="aiInstructions"
          name="aiInstructions"
          defaultValue={instructions}
          rows={4}
          maxLength={2000}
          placeholder="We are Overflow Connections. Keep replies warm, clear, and under 150 words unless detail is needed."
        />
      </ActionField>
      <ActionField label="Monthly AI request limit" name="monthlyAiLimit" hint="Counts summarize, suggest reply, and improve actions (UTC calendar month).">
        <Input id="monthlyAiLimit" name="monthlyAiLimit" type="number" min={0} max={100000} defaultValue={monthlyLimit} required className="max-w-40" />
      </ActionField>
      <SubmitButton pendingLabel="Saving…">Save AI settings</SubmitButton>
    </ActionForm>
  );
}
