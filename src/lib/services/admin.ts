import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/authz";
import { generateInviteToken } from "@/lib/crypto/api-keys";
import { getAppUrl, getRequestAppUrl } from "@/lib/env";
import type { AdminClient } from "@/lib/supabase/admin";
import type { WorkspaceRow } from "@/lib/types/database";

/**
 * Platform-admin operations (service-role writes, each gated by
 * requirePlatformAdmin() FIRST). Platform admins manage workspaces; they do
 * not gain access to message content (no mailbox grant is created here).
 *
 * Suspension semantics (enforced elsewhere, relied on here):
 *   - enqueue_outbound_message() refuses non-active workspaces  -> no new sends (UI + API);
 *   - authenticateApiKey() rejects keys of non-active workspaces -> API is 401;
 *   - processOutboxJob() re-checks status at send time           -> queued jobs fail & release quota;
 *   - inbound routing does NOT check workspace status            -> mail keeps arriving.
 */

export type AdminCtx = { admin: AdminClient; userId: string };

export class AdminServiceError extends Error {
  constructor(
    readonly code: "not_found" | "slug_taken" | "invalid_request",
    message: string,
    readonly status: 404 | 409 | 422 = 422,
  ) {
    super(message);
    this.name = "AdminServiceError";
  }
}

const email = z.email().max(254).transform((v) => v.trim().toLowerCase());
const uuid = z.uuid();
const limit = z.number().int().min(0).max(10_000_000);

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return slug;
}

async function audit(ctx: AdminCtx, workspaceId: string | null, action: string, metadata: Record<string, string | number | null> = {}) {
  await ctx.admin.from("audit_logs").insert({
    workspace_id: workspaceId,
    actor_user_id: ctx.userId,
    action,
    resource_type: "workspace",
    resource_id: workspaceId,
    metadata, // ids / field names only — never message content
  });
}

async function loadWorkspace(admin: AdminClient, id: string): Promise<WorkspaceRow> {
  const { data, error } = await admin.from("workspaces").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`workspace lookup failed: ${error.message}`);
  if (!data) throw new AdminServiceError("not_found", "Workspace not found", 404);
  return data;
}

// ---- create ------------------------------------------------------------------------------------------------------
export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().max(63).optional(),
  monthlySendingLimit: limit.default(3000),
  ownerEmail: email.optional(),
});

export type InviteResult =
  | { kind: "membership_created"; userId: string }
  | { kind: "invitation_created"; invitationId: string; expiresAt: string; inviteUrl: string };

export async function createWorkspace(
  ctx: AdminCtx,
  rawInput: z.input<typeof createWorkspaceSchema>,
): Promise<{ workspace: WorkspaceRow; owner: InviteResult | null }> {
  await requirePlatformAdmin(ctx.admin, ctx.userId);
  const input = createWorkspaceSchema.parse(rawInput);
  const slug = input.slug ? slugify(input.slug) : slugify(input.name);
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    throw new AdminServiceError("invalid_request", "Could not derive a valid slug; provide one (a-z, 0-9, hyphens)", 422);
  }

  const { data: ws, error } = await ctx.admin
    .from("workspaces")
    .insert({ name: input.name, slug, status: "active", monthly_sending_limit: input.monthlySendingLimit })
    .select("*")
    .single();
  if (error || !ws) {
    if (error?.code === "23505") throw new AdminServiceError("slug_taken", `Slug "${slug}" is already in use`, 409);
    throw new Error(`workspace insert failed: ${error?.message ?? "no data"}`);
  }
  await audit(ctx, ws.id, "workspace.created", { slug, monthly_sending_limit: ws.monthly_sending_limit });

  const owner = input.ownerEmail ? await inviteOwner(ctx, { workspaceId: ws.id, email: input.ownerEmail }) : null;
  return { workspace: ws, owner };
}

// ---- invite owner ----------------------------------------------------------------------------------------------------
export const inviteOwnerSchema = z.object({ workspaceId: uuid, email });
export const INVITE_TTL_DAYS = 7;

/**
 * If the person already has an account they become owner immediately.
 * Otherwise a single-use invitation (role=owner) is created and the raw token
 * is returned ONCE as an invite URL — only its HMAC is stored. No email is
 * sent from here: deliver the link yourself (or wire it to your mailer).
 */
export async function inviteOwner(ctx: AdminCtx, rawInput: z.input<typeof inviteOwnerSchema>): Promise<InviteResult> {
  await requirePlatformAdmin(ctx.admin, ctx.userId);
  const input = inviteOwnerSchema.parse(rawInput);
  await loadWorkspace(ctx.admin, input.workspaceId);

  const { data: profile, error: pErr } = await ctx.admin.from("profiles").select("id").eq("email", input.email).maybeSingle();
  if (pErr) throw new Error(`profile lookup failed: ${pErr.message}`);

  if (profile) {
    const { error } = await ctx.admin
      .from("workspace_memberships")
      .upsert({ workspace_id: input.workspaceId, user_id: profile.id, role: "owner" }, { onConflict: "workspace_id,user_id" });
    if (error) throw new Error(`owner membership failed: ${error.message}`);
    await audit(ctx, input.workspaceId, "workspace.owner_added", { user_id: profile.id });
    return { kind: "membership_created", userId: profile.id };
  }

  // Supersede any pending invite for this address (tokens are stored hashed, so a new one is minted).
  await ctx.admin
    .from("workspace_invitations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("workspace_id", input.workspaceId)
    .eq("email", input.email)
    .is("accepted_at", null)
    .is("revoked_at", null);

  const { token, tokenHash } = generateInviteToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: inv, error } = await ctx.admin
    .from("workspace_invitations")
    .insert({
      workspace_id: input.workspaceId,
      email: input.email,
      role: "owner",
      token_hash: tokenHash,
      expires_at: expiresAt,
      invited_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error || !inv) throw new Error(`invitation insert failed: ${error?.message ?? "no data"}`);
  await audit(ctx, input.workspaceId, "workspace.owner_invited", { invitation_id: inv.id });
  const origin = await getRequestAppUrl().catch(() => getAppUrl());
  return { kind: "invitation_created", invitationId: inv.id, expiresAt, inviteUrl: `${origin}/invite/${token}` };
}

// ---- suspend / reinstate / limits --------------------------------------------------------------------------------------
export const suspendSchema = z.object({ workspaceId: uuid, reason: z.string().trim().max(500).optional() });

export async function suspendWorkspace(ctx: AdminCtx, rawInput: z.input<typeof suspendSchema>): Promise<WorkspaceRow> {
  await requirePlatformAdmin(ctx.admin, ctx.userId);
  const input = suspendSchema.parse(rawInput);
  const before = await loadWorkspace(ctx.admin, input.workspaceId);
  const ws = await setStatus(ctx, before.id, "suspended");
  await audit(ctx, ws.id, "workspace.suspended", { previous_status: before.status, reason: input.reason ?? null });
  return ws;
}

export async function reinstateWorkspace(ctx: AdminCtx, rawInput: { workspaceId: string }): Promise<WorkspaceRow> {
  await requirePlatformAdmin(ctx.admin, ctx.userId);
  const input = z.object({ workspaceId: uuid }).parse(rawInput);
  const before = await loadWorkspace(ctx.admin, input.workspaceId);
  const ws = await setStatus(ctx, before.id, "active");
  await audit(ctx, ws.id, "workspace.reinstated", { previous_status: before.status });
  return ws;
}

async function setStatus(ctx: AdminCtx, id: string, status: "active" | "suspended"): Promise<WorkspaceRow> {
  const { data, error } = await ctx.admin.from("workspaces").update({ status }).eq("id", id).select("*").single();
  if (error || !data) throw new Error(`workspace status update failed: ${error?.message ?? "no data"}`);
  return data;
}

export const setLimitsSchema = z.object({ workspaceId: uuid, monthlySendingLimit: limit });

export async function setWorkspaceLimits(ctx: AdminCtx, rawInput: z.input<typeof setLimitsSchema>): Promise<WorkspaceRow> {
  await requirePlatformAdmin(ctx.admin, ctx.userId);
  const input = setLimitsSchema.parse(rawInput);
  const before = await loadWorkspace(ctx.admin, input.workspaceId);
  const { data, error } = await ctx.admin
    .from("workspaces")
    .update({ monthly_sending_limit: input.monthlySendingLimit })
    .eq("id", before.id)
    .select("*")
    .single();
  if (error || !data) throw new Error(`limit update failed: ${error?.message ?? "no data"}`);
  await audit(ctx, data.id, "workspace.limits_changed", {
    previous_monthly_sending_limit: before.monthly_sending_limit,
    monthly_sending_limit: data.monthly_sending_limit,
  });
  return data;
}
