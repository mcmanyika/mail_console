"use client";

import { RefreshCw } from "lucide-react";
import { addDomainAction, recheckDomainAction } from "@/lib/actions/domains";
import { ActionField, ActionForm } from "@/components/ui/action-form";
import { Input } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";

export function AddDomainForm({ workspaceId }: { workspaceId: string }) {
  return (
    <ActionForm action={addDomainAction} resetOnSuccess className="max-w-xl">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <ActionField
        label="Domain"
        name="hostname"
        hint="Use a subdomain such as mail.example.com so your root domain's existing email keeps working."
      >
        <div className="flex gap-2">
          <Input id="hostname" name="hostname" defaultValue="mail." placeholder="mail.example.com" required autoCapitalize="none" spellCheck={false} className="font-mono" />
          <SubmitButton pendingLabel="Adding…" className="shrink-0">
            Add domain
          </SubmitButton>
        </div>
      </ActionField>
    </ActionForm>
  );
}

export function RecheckButton({ domainId }: { domainId: string }) {
  return (
    <ActionForm action={recheckDomainAction} className="space-y-2">
      <input type="hidden" name="domainId" value={domainId} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Checking DNS…">
        <RefreshCw className="size-3.5" aria-hidden /> Recheck DNS
      </SubmitButton>
    </ActionForm>
  );
}
