import { hashInviteToken } from "@/lib/crypto/api-keys";
import { createAdminClient } from "@/lib/supabase/admin";
import type { WorkspaceInvitationRow } from "@/lib/types/database";

export type InviteLookup =
  | { state: "invalid" }
  | {
      state: "valid" | "expired" | "revoked" | "accepted";
      invitation: Omit<WorkspaceInvitationRow, "token_hash">;
      workspaceName: string;
      workspaceSlug: string;
    };

/** Looks an invitation up by its raw token (service role; the token itself is the credential). */
export async function lookupInvite(token: string): Promise<InviteLookup> {
  if (!token || token.length < 20 || token.length > 200) return { state: "invalid" };
  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("workspace_invitations")
    .select("*")
    .eq("token_hash", hashInviteToken(token))
    .maybeSingle();
  if (error) throw new Error(`invite lookup failed: ${error.message}`);
  if (!row) return { state: "invalid" };
  const { data: ws } = await admin.from("workspaces").select("name, slug").eq("id", row.workspace_id).maybeSingle();
  if (!ws) return { state: "invalid" };
  const { token_hash: _omit, ...invitation } = row;
  void _omit;
  const state = row.accepted_at
    ? "accepted"
    : row.revoked_at
      ? "revoked"
      : new Date(row.expires_at).getTime() < Date.now()
        ? "expired"
        : "valid";
  return { state, invitation, workspaceName: ws.name, workspaceSlug: ws.slug };
}
