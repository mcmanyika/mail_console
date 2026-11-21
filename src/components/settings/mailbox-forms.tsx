"use client";

import { useActionState } from "react";
import { Check } from "lucide-react";
import { createMailboxAction, setMailboxGrantAction } from "@/lib/actions/settings";
import { idleState } from "@/lib/actions/state";
import { ActionField, ActionForm } from "@/components/ui/action-form";
import { Input, Select } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";
import type { MailboxPermission } from "@/lib/types/database";

export function CreateMailboxForm({
  slug,
  domains,
}: {
  slug: string;
  domains: { id: string; hostname: string }[];
}) {
  return (
    <ActionForm action={createMailboxAction} resetOnSuccess className="max-w-2xl">
      <input type="hidden" name="slug" value={slug} />
      <div className="grid gap-4 sm:grid-cols-[1fr_auto_1fr]">
        <ActionField label="Address" name="local">
          <Input id="local" name="local" placeholder="support" required autoCapitalize="none" spellCheck={false} className="font-mono" />
        </ActionField>
        <div className="hidden pt-8 text-muted sm:block">@</div>
        <ActionField label="Domain" name="domainId">
          <Select id="domainId" name="domainId" required defaultValue="">
            <option value="" disabled>
              Choose domain…
            </option>
            {domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.hostname}
              </option>
            ))}
          </Select>
        </ActionField>
      </div>
      <ActionField label="Display name" name="displayName" hint="Shown as the sender name, e.g. “Acme Support”.">
        <Input id="displayName" name="displayName" placeholder="Acme Support" maxLength={120} />
      </ActionField>
      <label className="flex items-start gap-2.5 text-[13px] text-ink-2">
        <input type="checkbox" name="grantSelf" className="mt-0.5 size-4 accent-[#4F46E5]" />
        <span>
          Also give me read &amp; send access
          <span className="block text-xs text-muted">Creating a mailbox does not give you access to its mail. Recorded in the audit log.</span>
        </span>
      </label>
      <SubmitButton pendingLabel="Creating…" className={domains.length ? "" : "pointer-events-none opacity-50"}>
        Create mailbox
      </SubmitButton>
    </ActionForm>
  );
}

export function GrantRow({
  slug,
  mailboxId,
  membershipId,
  current,
  disabled,
  disabledReason,
}: {
  slug: string;
  mailboxId: string;
  membershipId: string;
  current: MailboxPermission | "none";
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [state, action] = useActionState(setMailboxGrantAction, idleState);
  return (
    <form action={action} className="flex flex-wrap items-center justify-end gap-2">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="mailboxId" value={mailboxId} />
      <input type="hidden" name="membershipId" value={membershipId} />
      <Select name="permission" defaultValue={current} disabled={disabled} className="h-8 w-36 text-[13px]" aria-label="Access level" title={disabledReason}>
        <option value="none">No access</option>
        <option value="read">Read</option>
        <option value="read_send">Read &amp; send</option>
      </Select>
      <SubmitButton variant="secondary" size="sm" pendingLabel="Saving…" className={disabled ? "pointer-events-none opacity-50" : ""}>
        Save
      </SubmitButton>
      <span className="w-20 text-xs" aria-live="polite">
        {state.status === "success" ? (
          <span className="inline-flex items-center gap-1 text-success">
            <Check className="size-3.5" aria-hidden /> {state.message === "No change." ? "No change" : "Saved"}
          </span>
        ) : state.status === "error" ? (
          <span className="text-danger" title={state.message}>
            Failed
          </span>
        ) : null}
      </span>
    </form>
  );
}
