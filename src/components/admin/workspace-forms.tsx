"use client";

import { useState } from "react";
import { inviteOwnerAction, setWorkspaceStatusAction, updatePlanAction } from "@/lib/actions/admin";
import { ActionField, ActionForm } from "@/components/ui/action-form";
import { ConfirmButton } from "@/components/ui/confirm-dialog";
import { Input, Select } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatPlanPrice, PLAN_LIST, type WorkspacePlan } from "@/lib/billing/plans";

export function UpdatePlanForm({
  workspaceId,
  plan,
  limit,
  aiLimit,
}: {
  workspaceId: string;
  plan: WorkspacePlan;
  limit: number;
  aiLimit: number;
}) {
  const [selected, setSelected] = useState<WorkspacePlan>(plan);

  return (
    <ActionForm action={updatePlanAction}>
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <ActionField label="Plan" name="plan" hint="Sets send/AI limits. Customers subscribe via Settings → Billing (Stripe).">
        <Select
          id="plan"
          name="plan"
          value={selected}
          onChange={(e) => setSelected(e.target.value as WorkspacePlan)}
          className="max-w-xs"
        >
          {PLAN_LIST.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} — {formatPlanPrice(p)} · {p.monthlySendingLimit.toLocaleString()} sends
            </option>
          ))}
          <option value="custom">Custom limits</option>
        </Select>
      </ActionField>
      {selected === "custom" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <ActionField label="Monthly sending limit" name="limit" hint="Unique recipients per UTC month.">
            <Input id="limit" name="limit" type="number" min={0} step={1} defaultValue={limit} className="tabular-nums" required />
          </ActionField>
          <ActionField label="Monthly AI limit" name="aiLimit">
            <Input id="aiLimit" name="aiLimit" type="number" min={0} step={1} defaultValue={aiLimit} className="tabular-nums" required />
          </ActionField>
        </div>
      ) : (
        <>
          <input type="hidden" name="limit" value={limit} />
          <p className="text-[13px] text-muted">
            Applying this plan sets send and AI limits to the package defaults.
          </p>
        </>
      )}
      <SubmitButton variant="secondary" pendingLabel="Saving…">
        Save plan
      </SubmitButton>
    </ActionForm>
  );
}

/** @deprecated Use UpdatePlanForm */
export function UpdateLimitForm({ workspaceId, limit }: { workspaceId: string; limit: number }) {
  return <UpdatePlanForm workspaceId={workspaceId} plan="custom" limit={limit} aiLimit={200} />;
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
