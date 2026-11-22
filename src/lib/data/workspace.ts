import type { User } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { AuthzError, getMembership, isPlatformAdmin, roleAtLeast } from "@/lib/auth/authz";
import { getCurrentUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import type {
  Database,
  MailboxPermission,
  MailboxRow,
  WorkspaceMembershipRow,
  WorkspaceRole,
  WorkspaceRow,
} from "@/lib/types/database";

export type UserClient = SupabaseClient<Database>;

export type WorkspaceContext = {
  user: User;
  supabase: UserClient;
  workspace: WorkspaceRow;
  membership: WorkspaceMembershipRow;
  role: WorkspaceRole;
};

/**
 * Resolves the workspace for a slug and the caller's membership. Non-members
 * (including platform admins, who manage workspaces from /admin) get a 404 so
 * workspace existence is not leaked and no mail access is implied.
 * Memoised per request. Call from inside <Suspense> (reads cookies).
 */
export const getWorkspaceContext = cache(async (slug: string): Promise<WorkspaceContext> => {
  const user = await getCurrentUser();
  if (!user) redirect(`/?next=${encodeURIComponent(`/w/${slug}/inbox`)}`);
  const supabase = await createClient();
  const { data: workspace, error } = await supabase.from("workspaces").select("*").eq("slug", slug).maybeSingle();
  if (error) throw new Error(`workspace lookup failed: ${error.message}`);
  if (!workspace) notFound();
  const membership = await getMembership(supabase, user.id, workspace.id);
  if (!membership) notFound();
  return { user, supabase, workspace, membership, role: membership.role };
});

/** Same as getWorkspaceContext but throws AuthzError (for server actions) instead of redirecting. */
export async function requireWorkspaceAction(slugOrId: { slug: string } | { id: string }, minRole: WorkspaceRole = "member") {
  const user = await getCurrentUser();
  if (!user) throw new AuthzError("You need to sign in again", 401);
  const supabase = await createClient();
  const q = supabase.from("workspaces").select("*");
  const { data: workspace, error } = await ("slug" in slugOrId
    ? q.eq("slug", slugOrId.slug)
    : q.eq("id", slugOrId.id)
  ).maybeSingle();
  if (error) throw new Error(`workspace lookup failed: ${error.message}`);
  if (!workspace) throw new AuthzError("Workspace not found", 404);
  const membership = await getMembership(supabase, user.id, workspace.id);
  if (!membership) throw new AuthzError("Workspace not found", 404);
  if (!roleAtLeast(membership.role, minRole)) throw new AuthzError(`This requires the ${minRole} role`);
  const ctx: WorkspaceContext = { user, supabase, workspace, membership, role: membership.role };
  return ctx;
}

/** Platform admin OR workspace admin+ (used for domain setup, which platform admins also perform). */
export async function requireDomainManager(workspaceId: string) {
  const user = await getCurrentUser();
  if (!user) throw new AuthzError("You need to sign in again", 401);
  const supabase = await createClient();
  const platform = await isPlatformAdmin(supabase, user.id);
  if (!platform) {
    const membership = await getMembership(supabase, user.id, workspaceId);
    if (!membership) throw new AuthzError("Workspace not found", 404);
    if (!roleAtLeast(membership.role, "admin")) throw new AuthzError("This requires the admin role");
  }
  const { data: workspace } = await supabase.from("workspaces").select("*").eq("id", workspaceId).maybeSingle();
  if (!workspace) throw new AuthzError("Workspace not found", 404);
  return { user, supabase, workspace, platform };
}

export async function requirePlatformAdminAction() {
  const user = await getCurrentUser();
  if (!user) throw new AuthzError("You need to sign in again", 401);
  const supabase = await createClient();
  if (!(await isPlatformAdmin(supabase, user.id))) throw new AuthzError("Platform admin access required");
  return { user, supabase };
}

// ---- mailbox helpers -------------------------------------------------------------
export type MailboxOption = {
  id: string;
  address: string;
  displayName: string | null;
  enabled: boolean;
  permission: MailboxPermission;
  domainId: string;
};

/**
 * Mailboxes the user has an EXPLICIT grant for (owners/admins included).
 * Reads through the user's RLS client, which enforces the same rule in SQL.
 */
export const getReadableMailboxes = cache(async (slug: string): Promise<MailboxOption[]> => {
  const ctx = await getWorkspaceContext(slug);
  const { data: grants, error } = await ctx.supabase
    .from("mailbox_access")
    .select("mailbox_id, permission")
    .eq("membership_id", ctx.membership.id);
  if (error) throw new Error(`failed to load mailbox grants: ${error.message}`);
  if (!grants?.length) return [];
  const { data: mailboxes, error: mbErr } = await ctx.supabase
    .from("mailboxes")
    .select("*")
    .in("id", grants.map((g) => g.mailbox_id))
    .order("address");
  if (mbErr) throw new Error(`failed to load mailboxes: ${mbErr.message}`);
  const perm = new Map(grants.map((g) => [g.mailbox_id, g.permission]));
  return (mailboxes ?? []).map((m: MailboxRow) => ({
    id: m.id,
    address: m.address,
    displayName: m.display_name,
    enabled: m.enabled,
    permission: perm.get(m.id) ?? "read",
    domainId: m.domain_id,
  }));
});

export function formatFrom(m: { address: string; displayName: string | null }): string {
  return m.displayName ? `${m.displayName.replace(/["<>]/g, "")} <${m.address}>` : m.address;
}
