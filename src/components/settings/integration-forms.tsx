"use client";

import { createIntegrationAction } from "@/lib/actions/settings";
import { ActionField, ActionForm } from "@/components/ui/action-form";
import { Input, Select } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";

export function CreateIntegrationForm({ slug, mailboxes }: { slug: string; mailboxes: { id: string; address: string }[] }) {
  return (
    <ActionForm action={createIntegrationAction} resetOnSuccess={false} className="max-w-2xl">
      <input type="hidden" name="slug" value={slug} />
      <div className="grid gap-4 sm:grid-cols-2">
        <ActionField label="Name" name="name" hint="Something you'll recognise later, e.g. “Billing app”.">
          <Input id="name" name="name" required maxLength={120} placeholder="Billing app" />
        </ActionField>
        <ActionField label="Allowed mailbox" name="allowedMailboxId" hint="Pin the key to one sender address, or allow any.">
          <Select id="allowedMailboxId" name="allowedMailboxId" defaultValue="">
            <option value="">Any mailbox in this workspace</option>
            {mailboxes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.address}
              </option>
            ))}
          </Select>
        </ActionField>
      </div>
      <SubmitButton pendingLabel="Creating…">Create API key</SubmitButton>
    </ActionForm>
  );
}
