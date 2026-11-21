"use client";

import { acceptInviteAction } from "@/lib/actions/invites";
import { ActionForm } from "@/components/ui/action-form";
import { SubmitButton } from "@/components/ui/submit-button";

export function AcceptInviteForm({ token, workspaceName }: { token: string; workspaceName: string }) {
  return (
    <ActionForm action={acceptInviteAction.bind(null, token)}>
      <SubmitButton size="lg" className="w-full" pendingLabel="Joining…">
        Join {workspaceName}
      </SubmitButton>
    </ActionForm>
  );
}
