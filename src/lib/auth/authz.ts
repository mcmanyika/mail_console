import type { SupabaseClient } from "@supabase/supabase-js";
import { extractBearerToken, parseApiKey, verifyApiKey } from "@/lib/crypto/api-keys";
import type { AdminClient } from "@/lib/supabase/admin";
import type {
  AppIntegrationRow,
  Database,
  MailboxPermission,
  MailboxRow,
  WorkspaceMembershipRow,
  WorkspaceRole,
} from "@/lib/types/database";

/**
 * Application-level authorization. RLS is the safety net; these helpers are the
 * first line of defence and are REQUIRED before any service-role query.
 *
 * Model
 *   - Workspace roles: owner > admin > member (settings / grants / domains).
 *   - Message content requires an explicit mailbox_access grant for EVERY role,
 *     including owners and admins. Hiding a button is never the authz check.
 *   - Platform admins manage workspaces but are NOT granted mailbox access by
 *     being platform admins (they need a real membership + grant).
 */

type UserClient = SupabaseClient<Database>;

// ---- errors -------------------------------------------------------------------
export class AuthzError extends Error {
  readonly status: 401 | 403 | 404;
  constructor(message: string, status: 401 | 403 | 404 = 403) {
    super(message);
    this.name = "AuthzError";
    this.status = status;
  }
}

// ---- pure rules (unit-tested) ---------------------------------------------------
const ROLE_RANK: Record<WorkspaceRole, number> = { member: 1, admin: 2, owner: 3 };

export function roleAtLeast(role: WorkspaceRole | null | undefined, min: WorkspaceRole): boolean {
  return role != null && ROLE_RANK[role] >= ROLE_RANK[min];
}

export type MailboxAction = "read" | "send";

export function permissionAllows(permission: MailboxPermission | null | undefined, action: MailboxAction): boolean {
  if (!permission) return false;
  return action === "read" ? true : permission === "read_send";
}

/**
 * Effective mailbox rights. Role alone never unlocks message content — only an
 * explicit grant does. `role` is accepted for call-site consistency / future rules.
 */
export function effectiveMailboxPermission(
  _role: WorkspaceRole | null | undefined,
  grant: MailboxPermission | null | undefined,
): MailboxPermission | null {
  return grant ?? null;
}

/** Can a role grant/modify a target role? Owners manage everyone; admins manage non-owners. */
export function canManageRole(actor: WorkspaceRole | null | undefined, target: WorkspaceRole): boolean {
  if (actor === "owner") return true;
  if (actor === "admin") return target !== "owner";
  return false;
}

// ---- platform admin ---------------------------------------------------------------
export async function isPlatformAdmin(client: UserClient | AdminClient, userId: string): Promise<boolean> {
  const { data, error } = await client.from("platform_admins").select("user_id").eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`platform admin check failed: ${error.message}`);
  return data !== null;
}

export async function requirePlatformAdmin(client: UserClient | AdminClient, userId: string): Promise<void> {
  if (!(await isPlatformAdmin(client, userId))) throw new AuthzError("Platform admin access required");
}

// ---- workspace membership -------------------------------------------------------------
export async function getMembership(
  client: UserClient | AdminClient,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceMembershipRow | null> {
  const { data, error } = await client
    .from("workspace_memberships")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`membership lookup failed: ${error.message}`);
  return data;
}

/** Throws unless the user is a member with at least `minRole`. Returns the membership. */
export async function requireWorkspaceRole(
  client: UserClient | AdminClient,
  userId: string,
  workspaceId: string,
  minRole: WorkspaceRole = "member",
): Promise<WorkspaceMembershipRow> {
  const membership = await getMembership(client, userId, workspaceId);
  // 404 (not 403) for non-members so workspace existence isn't leaked.
  if (!membership) throw new AuthzError("Workspace not found", 404);
  if (!roleAtLeast(membership.role, minRole)) throw new AuthzError(`Requires workspace role: ${minRole}`);
  return membership;
}

export async function listUserWorkspaceIds(client: UserClient | AdminClient, userId: string): Promise<string[]> {
  const { data, error } = await client.from("workspace_memberships").select("workspace_id").eq("user_id", userId);
  if (error) throw new Error(`workspace list failed: ${error.message}`);
  return (data ?? []).map((r) => r.workspace_id);
}

// ---- mailbox access -----------------------------------------------------------------------
export type MailboxAccess = {
  mailbox: MailboxRow;
  membership: WorkspaceMembershipRow;
  permission: MailboxPermission;
};

/**
 * Resolves the user's rights on a mailbox and throws unless they satisfy
 * `action`. Sending additionally requires the mailbox to be enabled.
 * (Workspace status — active/suspended — is enforced separately at enqueue time.)
 */
export async function requireMailboxAccess(
  client: UserClient | AdminClient,
  userId: string,
  mailboxId: string,
  action: MailboxAction = "read",
): Promise<MailboxAccess> {
  const { data: mailbox, error } = await client.from("mailboxes").select("*").eq("id", mailboxId).maybeSingle();
  if (error) throw new Error(`mailbox lookup failed: ${error.message}`);
  if (!mailbox) throw new AuthzError("Mailbox not found", 404);

  const membership = await getMembership(client, userId, mailbox.workspace_id);
  if (!membership) throw new AuthzError("Mailbox not found", 404);

  const { data: grantRow, error: grantErr } = await client
    .from("mailbox_access")
    .select("permission")
    .eq("membership_id", membership.id)
    .eq("mailbox_id", mailboxId)
    .maybeSingle();
  if (grantErr) throw new Error(`mailbox grant lookup failed: ${grantErr.message}`);

  const permission = effectiveMailboxPermission(membership.role, grantRow?.permission ?? null);
  if (!permission) throw new AuthzError("Mailbox not found", 404);
  if (!permissionAllows(permission, action)) throw new AuthzError("You only have read access to this mailbox");
  if (action === "send" && !mailbox.enabled) throw new AuthzError("This mailbox is disabled");
  return { mailbox, membership, permission };
}

/** Ids of every mailbox the user can read (for inbox switchers). Requires explicit grants. */
export async function listReadableMailboxIds(
  client: UserClient | AdminClient,
  userId: string,
  workspaceId: string,
): Promise<string[]> {
  const membership = await getMembership(client, userId, workspaceId);
  if (!membership) return [];
  const { data, error } = await client.from("mailbox_access").select("mailbox_id").eq("membership_id", membership.id);
  if (error) throw new Error(`mailbox grant list failed: ${error.message}`);
  return (data ?? []).map((g) => g.mailbox_id);
}

// ---- API-key (app integration) auth -----------------------------------------------------------
export type IntegrationContext = {
  integration: Omit<AppIntegrationRow, "key_hash">;
};

/**
 * Authenticates a transactional-API request from `Authorization: Bearer mck_…`.
 * Looks the key up by its public prefix, then verifies the HMAC in constant time.
 * Returns null for any failure (callers must respond with a generic 401).
 * Requires the SERVICE-ROLE client (the table is not readable by end users).
 */
export async function authenticateApiKey(
  admin: AdminClient,
  authorizationHeader: string | null | undefined,
): Promise<IntegrationContext | null> {
  const presented = extractBearerToken(authorizationHeader);
  if (!presented) return null;
  const parsed = parseApiKey(presented);
  if (!parsed) return null;

  const { data: row, error } = await admin
    .from("app_integrations")
    .select("*")
    .eq("key_prefix", parsed.keyPrefix)
    .maybeSingle();
  if (error || !row) return null;
  if (row.revoked_at) return null;
  if (!verifyApiKey(presented, row.key_hash)) return null;

  // Workspace must be active for API sends.
  const { data: ws } = await admin.from("workspaces").select("status").eq("id", row.workspace_id).maybeSingle();
  if (!ws || ws.status !== "active") return null;

  // Best-effort; never block the request on bookkeeping.
  void admin
    .from("app_integrations")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", row.id)
    .then(() => undefined, () => undefined);

  const integration: Omit<AppIntegrationRow, "key_hash"> = {
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    allowed_mailbox_id: row.allowed_mailbox_id,
    key_prefix: row.key_prefix,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
    created_by: row.created_by,
    created_at: row.created_at,
  };
  return { integration };
}

/** An integration may send from `mailboxId` iff it is workspace-wide or pinned to exactly that mailbox. */
export function integrationMayUseMailbox(
  integration: Pick<AppIntegrationRow, "allowed_mailbox_id" | "workspace_id">,
  mailbox: Pick<MailboxRow, "id" | "workspace_id">,
): boolean {
  if (integration.workspace_id !== mailbox.workspace_id) return false;
  return integration.allowed_mailbox_id === null || integration.allowed_mailbox_id === mailbox.id;
}
