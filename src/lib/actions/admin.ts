"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { generateInviteToken } from "@/lib/crypto/api-keys";
import { requirePlatformAdminAction } from "@/lib/data/workspace";
import { getAppUrl } from "@/lib/env";
import { slugify } from "@/lib/format";
import { createAdminClient } from "@/lib/supabase/admin";
import { formString, guarded } from "./guard";
import { fail, ok, type ActionState } from "./state";

const INVITE_TTL_DAYS = 14;
const MAX_LIMIT = 10_000_000;

const createClientSchema = z.object({
  name: z.string().trim().min(1, "Enter a client name").max(120),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, "Lowercase letters, numbers and hyphens only"),
  limit: z.coerce.number().int("Whole numbers only").min(0).max(MAX_LIMIT),
  ownerEmail: z.string().trim().toLowerCase().email("Enter the owner's email address"),
});

async function createInvitation(
  admin: ReturnType<typeof createAdminClient>,
  params: { workspaceId: string; email: string; invitedBy: string },
) {
  // Replace any still-pending invite for the same address (unique pending index).
  await admin
    .from("workspace_invitations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("workspace_id", params.workspaceId)
    .eq("email", params.email)
    .is("accepted_at", null)
    .is("revoked_at", null);
  const { token, tokenHash } = generateInviteToken();
  const { data, error } = await admin
    .from("workspace_invitations")
    .insert({
      workspace_id: params.workspaceId,
      email: params.email,
      role: "owner",
      token_hash: tokenHash,
      expires_at: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000).toISOString(),
      invited_by: params.invitedBy,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "invite insert failed");
  return { id: data.id, url: `${getAppUrl()}/invite/${token}` };
}

/** Add-client flow: create the workspace, set its limit, invite its owner. */
export async function createClientAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return guarded(async () => {
    const { user } = await requirePlatformAdminAction();
    const name = formString(formData, "name");
    const parsed = createClientSchema.safeParse({
      name,
      slug: formString(formData, "slug") || slugify(name),
      limit: formString(formData, "limit") || "3000",
      ownerEmail: formString(formData, "ownerEmail"),
    });
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const i of parsed.error.issues) fieldErrors[String(i.path[0])] ??= i.message;
      return fail("Check the highlighted fields.", fieldErrors);
    }
    const v = parsed.data;
    const admin = createAdminClient();
    const { data: ws, error } = await admin
      .from("workspaces")
      .insert({ name: v.name, slug: v.slug, status: "active", monthly_sending_limit: v.limit })
      .select("id, slug")
      .single();
    if (error || !ws) {
      if (error?.code === "23505") return fail("That URL slug is taken.", { slug: "Already in use" });
      throw new Error(error?.message ?? "workspace insert failed");
    }
    const invite = await createInvitation(admin, { workspaceId: ws.id, email: v.ownerEmail, invitedBy: user.id });
    await writeAudit(admin, {
      workspaceId: ws.id,
      actorUserId: user.id,
      action: "workspace.created",
      resourceType: "workspace",
      resourceId: ws.id,
      metadata: { limit: v.limit },
    });
    await writeAudit(admin, {
      workspaceId: ws.id,
      actorUserId: user.id,
      action: "invitation.created",
      resourceType: "workspace_invitation",
      resourceId: invite.id,
      metadata: { email: v.ownerEmail, as: "owner" },
    });
    revalidatePath("/admin");
    return ok(`${v.name} is ready. Share the owner invite link below — it is shown only once.`, {
      reveal: {
        label: `Owner invitation for ${v.ownerEmail}`,
        value: invite.url,
        note: `Single use, expires in ${INVITE_TTL_DAYS} days. The first person to accept becomes the workspace owner.`,
      },
      links: [
        { href: `/admin/workspaces/${ws.id}#domains`, label: "Set up the sending domain" },
        { href: `/admin/workspaces/${ws.id}`, label: "Open workspace" },
      ],
    });
  });
}

export async function inviteOwnerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return guarded(async () => {
    const { user } = await requirePlatformAdminAction();
    const workspaceId = formString(formData, "workspaceId");
    const email = z.string().trim().toLowerCase().email().safeParse(formString(formData, "email"));
    if (!email.success) return fail("Enter a valid email address.", { email: "Enter a valid email address" });
    const admin = createAdminClient();
    const { data: ws } = await admin.from("workspaces").select("id").eq("id", workspaceId).maybeSingle();
    if (!ws) return fail("Workspace not found.");
    const invite = await createInvitation(admin, { workspaceId, email: email.data, invitedBy: user.id });
    await writeAudit(admin, {
      workspaceId,
      actorUserId: user.id,
      action: "invitation.created",
      resourceType: "workspace_invitation",
      resourceId: invite.id,
      metadata: { email: email.data, by: "platform_admin" },
    });
    revalidatePath(`/admin/workspaces/${workspaceId}`);
    return ok("Invitation created.", {
      reveal: { label: `Invitation for ${email.data}`, value: invite.url, note: "Single use. Shown only once." },
    });
  });
}

export async function revokeInvitationAdminAction(formData: FormData): Promise<void> {
  const { user } = await requirePlatformAdminAction();
  const invitationId = formString(formData, "invitationId");
  const workspaceId = formString(formData, "workspaceId");
  const admin = createAdminClient();
  await admin
    .from("workspace_invitations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", invitationId)
    .eq("workspace_id", workspaceId)
    .is("accepted_at", null);
  await writeAudit(admin, {
    workspaceId,
    actorUserId: user.id,
    action: "invitation.revoked",
    resourceType: "workspace_invitation",
    resourceId: invitationId,
    metadata: { by: "platform_admin" },
  });
  revalidatePath(`/admin/workspaces/${workspaceId}`);
}

export async function setWorkspaceStatusAction(formData: FormData): Promise<void> {
  const { user } = await requirePlatformAdminAction();
  const workspaceId = formString(formData, "workspaceId");
  const status = formString(formData, "status");
  if (status !== "active" && status !== "suspended") throw new Error("invalid status");
  const admin = createAdminClient();
  const { data: ws, error } = await admin
    .from("workspaces")
    .update({ status })
    .eq("id", workspaceId)
    .select("id, slug")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!ws) throw new Error("workspace not found");
  await writeAudit(admin, {
    workspaceId,
    actorUserId: user.id,
    action: status === "suspended" ? "workspace.suspended" : "workspace.reactivated",
    resourceType: "workspace",
    resourceId: workspaceId,
  });
  revalidatePath("/admin");
  revalidatePath(`/admin/workspaces/${workspaceId}`);
  revalidatePath(`/w/${ws.slug}`, "layout");
  redirect(`/admin/workspaces/${workspaceId}`);
}

export async function updateLimitAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return guarded(async () => {
    const { user } = await requirePlatformAdminAction();
    const workspaceId = formString(formData, "workspaceId");
    const limit = z.coerce.number().int().min(0).max(MAX_LIMIT).safeParse(formString(formData, "limit"));
    if (!limit.success) return fail("Enter a whole number between 0 and 10,000,000.", { limit: "Invalid limit" });
    const admin = createAdminClient();
    const { data: before } = await admin.from("workspaces").select("monthly_sending_limit").eq("id", workspaceId).maybeSingle();
    if (!before) return fail("Workspace not found.");
    const { error } = await admin.from("workspaces").update({ monthly_sending_limit: limit.data }).eq("id", workspaceId);
    if (error) throw new Error(error.message);
    await writeAudit(admin, {
      workspaceId,
      actorUserId: user.id,
      action: "workspace.limit_changed",
      resourceType: "workspace",
      resourceId: workspaceId,
      metadata: { from: before.monthly_sending_limit, to: limit.data },
    });
    revalidatePath("/admin");
    revalidatePath(`/admin/workspaces/${workspaceId}`);
    return ok("Monthly limit updated.");
  });
}
