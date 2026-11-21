"use client";

import { useActionState } from "react";
import { Check } from "lucide-react";
import { changeRoleAction, inviteMemberAction } from "@/lib/actions/settings";
import { idleState } from "@/lib/actions/state";
import { ActionField, ActionForm } from "@/components/ui/action-form";
import { Input, Select } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";
import type { WorkspaceRole } from "@/lib/types/database";

export function InviteMemberForm({ slug, canInviteAdmin }: { slug: string; canInviteAdmin: boolean }) {
  return (
    <ActionForm action={inviteMemberAction} resetOnSuccess hideSuccessMessage={false} className="max-w-2xl">
      <input type="hidden" name="slug" value={slug} />
      <div className="grid gap-4 sm:grid-cols-[1fr_11rem_auto] sm:items-end">
        <ActionField label="Email" name="email">
          <Input id="email" name="email" type="email" required placeholder="teammate@company.com" />
        </ActionField>
        <ActionField label="Role" name="role">
          <Select id="role" name="role" defaultValue="member">
            <option value="member">Member</option>
            {canInviteAdmin ? <option value="admin">Admin</option> : null}
          </Select>
        </ActionField>
        <SubmitButton pendingLabel="Inviting…">Create invite</SubmitButton>
      </div>
      <p className="text-xs text-muted">
        Members can use the workspace; admins also manage settings and grants. Neither role can read any mailbox until it&apos;s
        granted.
      </p>
    </ActionForm>
  );
}

export function RoleSelect({
  slug,
  membershipId,
  role,
  options,
  disabled,
  reason,
}: {
  slug: string;
  membershipId: string;
  role: WorkspaceRole;
  options: WorkspaceRole[];
  disabled?: boolean;
  reason?: string;
}) {
  const [state, action] = useActionState(changeRoleAction, idleState);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="membershipId" value={membershipId} />
      <Select name="role" defaultValue={role} disabled={disabled} title={reason} className="h-8 w-28 text-[13px] capitalize" aria-label="Role">
        {options.map((r) => (
          <option key={r} value={r} className="capitalize">
            {r}
          </option>
        ))}
      </Select>
      {!disabled ? (
        <SubmitButton variant="secondary" size="sm" pendingLabel="…">
          Save
        </SubmitButton>
      ) : null}
      <span className="text-xs" aria-live="polite">
        {state.status === "success" ? (
          <span className="inline-flex items-center gap-1 text-success">
            <Check className="size-3.5" aria-hidden /> Saved
          </span>
        ) : state.status === "error" ? (
          <span className="text-danger">{state.message}</span>
        ) : null}
      </span>
    </form>
  );
}
