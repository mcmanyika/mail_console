"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { writeAudit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth/session";
import { lookupInvite } from "@/lib/data/invites";
import { createAdminClient } from "@/lib/supabase/admin";
import { guarded } from "./guard";
import { fail, type ActionState } from "./state";

/**
 * Accepts a workspace invitation. The signed-in user's verified email must
 * match the invited address — the token alone is not enough.
 *
 * Role: use the invitation's role. If the invite is not `owner` but the
 * workspace still has no owner (bootstrap edge case), promote to owner.
 */
export async function acceptInviteAction(token: string, prev: ActionState): Promise<ActionState> {
  void prev;
  let destination: string | null = null;
  const result = await guarded(async () => {
    const user = await getCurrentUser();
    if (!user) return fail("Sign in to accept this invitation.");
    const invite = await lookupInvite(token);
    if (invite.state === "invalid") return fail("This invitation link isn't valid.");
    if (invite.state === "accepted") return fail("This invitation has already been used.");
    if (invite.state === "revoked") return fail("This invitation was revoked. Ask for a new one.");
    if (invite.state === "expired") return fail("This invitation has expired. Ask for a new one.");

    const email = user.email?.toLowerCase();
    if (!email || email !== invite.invitation.email) {
      return fail(`This invitation was sent to ${invite.invitation.email}. Sign in with that address to accept it.`);
    }
    if (!user.email_confirmed_at) return fail("Confirm your email address first, then accept the invitation.");

    const admin = createAdminClient();
    const { workspace_id: workspaceId } = invite.invitation;

    const { data: existing } = await admin
      .from("workspace_memberships")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (existing) {
      destination = `/w/${invite.workspaceSlug}/inbox`;
      return { status: "success" };
    }

    // Claim the invitation atomically (single-use).
    const { data: claimed, error: claimErr } = await admin
      .from("workspace_invitations")
      .update({ accepted_at: new Date().toISOString() })
      .eq("id", invite.invitation.id)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .select("id")
      .maybeSingle();
    if (claimErr) throw new Error(claimErr.message);
    if (!claimed) return fail("This invitation has already been used.");

    const { count: ownerCount } = await admin
      .from("workspace_memberships")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("role", "owner");
    const invitedRole = invite.invitation.role;
    const role = invitedRole === "owner" || (ownerCount ?? 0) === 0 ? "owner" : invitedRole;

    const { error: memErr } = await admin
      .from("workspace_memberships")
      .insert({ workspace_id: workspaceId, user_id: user.id, role });
    if (memErr) {
      await admin.from("workspace_invitations").update({ accepted_at: null }).eq("id", invite.invitation.id);
      throw new Error(memErr.message);
    }

    await writeAudit(admin, {
      workspaceId,
      actorUserId: user.id,
      action: "invitation.accepted",
      resourceType: "workspace_invitation",
      resourceId: invite.invitation.id,
      metadata: { role },
    });
    destination = `/w/${invite.workspaceSlug}/inbox`;
    return { status: "success" };
  });
  if (result.status === "success" && destination) {
    revalidatePath("/dashboard");
    redirect(destination);
  }
  return result;
}
