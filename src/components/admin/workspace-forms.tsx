"use client";

import { inviteOwnerAction, setWorkspaceStatusAction, updateLimitAction } from "@/lib/actions/admin";
import { ActionField, ActionForm } from "@/components/ui/action-form";
import { ConfirmButton } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";

export function UpdateLimitForm({ workspaceId, limit }: { workspaceId: string; limit: number }) {
  return (
    <ActionForm action={updateLimitAction}>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <ActionField label="Monthly sending limit" name="limit" hint="Unique recipients per UTC month.">
        <div className="flex gap-2">
          <Input id="limit" name="limit" type="number" min={0} step={1} defaultValue={limit} className="max-w-40 tabular-nums" required />
          <SubmitButton variant="secondary" pendingLabel="Saving…">
            Save limit
          </SubmitButton>
        </div>
      </ActionField>
    </ActionForm>
  );
}

export function InviteOwnerForm({ workspaceId, hasOwner }: { workspaceId: string; hasOwner: boolean }) {
  return (
    <ActionForm action={inviteOwnerAction} resetOnSuccess>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <ActionField
        label={hasOwner ? "Invite an admin" : "Invite the owner"}
        name="email"
        hint={hasOwner ? "Joins as an admin. Owners can promote them later." : "This workspace has no owner yet — the first person to accept becomes its owner."}
      >
        <div className="flex gap-2">
          <Input id="email" name="email" type="email" placeholder="owner@client.com" required />
          <SubmitButton variant="secondary" pendingLabel="Inviting…" className="shrink-0">
            Create link
          </SubmitButton>
        </div>
      </ActionField>
    </ActionForm>
  );
}

export function SuspendControls({
  workspaceId,
  name,
  status,
}: {
  workspaceId: string;
  name: string;
  status: string;
}) {
  if (status === "suspended") {
    return (
      <form action={setWorkspaceStatusAction}>
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="status" value="active" />
        <SubmitButton variant="primary" pendingLabel="Reactivating…">
          Reactivate workspace
        </SubmitButton>
      </form>
    );
  }
  return (
    <ConfirmButton
      action={setWorkspaceStatusAction}
      hiddenFields={{ workspaceId, status: "suspended" }}
      triggerLabel="Suspend workspace"
      title={`Suspend ${name}?`}
      confirmLabel="Suspend workspace"
      description={
        <>
          <p>This takes effect immediately:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              <strong className="font-medium text-ink-2">Outbound sending stops</strong> — queued messages fail instead of sending.
            </li>
            <li>
              <strong className="font-medium text-ink-2">The transactional API stops</strong> — API keys are rejected.
            </li>
            <li>
              <strong className="font-medium text-ink-2">Inbound mail is still received</strong> and stored; members can still read it.
            </li>
          </ul>
          <p className="mt-2">You can reactivate at any time.</p>
        </>
      }
    />
  );
}
