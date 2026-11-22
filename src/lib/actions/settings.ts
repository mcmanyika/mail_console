"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { canManageRole } from "@/lib/auth/authz";
import { generateApiKey, generateInviteToken } from "@/lib/crypto/api-keys";
import { requireWorkspaceAction } from "@/lib/data/workspace";
import { textToHtml } from "@/lib/email/sanitize";
import { getRequestAppUrl } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json, MailboxPermission, WorkspaceRole } from "@/lib/types/database";
import { formString, guarded } from "./guard";
import { fail, ok, type ActionState } from "./state";

const INVITE_TTL_DAYS = 7;

function zodFields(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of error.issues) out[String(i.path[0] ?? "form")] ??= i.message;
  return out;
}
const refresh = (slug: string, section: string) => revalidatePath(`/w/${slug}/settings/${section}`);

// =========================== mailboxes & grants ===========================
const LOCAL_PART = /^[a-z0-9][a-z0-9._%+-]{0,63}$/;

export async function createMailboxAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return guarded(async () => {
    const slug = formString(formData, "slug");
    const ctx = await requireWorkspaceAction({ slug }, "admin");
    const local = formString(formData, "local").toLowerCase();
    const domainId = formString(formData, "domainId");
    const displayName = formString(formData, "displayName").slice(0, 120) || null;
    if (!LOCAL_PART.test(local)) return fail("Use letters, numbers and . _ % + - only.", { local: "Invalid address name" });

    const admin = createAdminClient();
    const { data: domain } = await admin.from("domains").select("id, hostname").eq("id", domainId).eq("workspace_id", ctx.workspace.id).maybeSingle();
    if (!domain) return fail("Choose one of your workspace's domains.", { domainId: "Pick a domain" });

    const address = `${local}@${domain.hostname}`;
    const { data: mb, error } = await admin
      .from("mailboxes")
      .insert({ workspace_id: ctx.workspace.id, domain_id: domain.id, address, display_name: displayName })
      .select("id")
      .single();
    if (error || !mb) {
      if (error?.code === "23505") return fail(`${address} already exists.`, { local: "Already exists" });
      throw new Error(error?.message ?? "mailbox insert failed");
    }
    await writeAudit(admin, { workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "mailbox.created", resourceType: "mailbox", resourceId: mb.id, metadata: { address } });

    if (formData.get("grantSelf") === "on") {
      await admin.from("mailbox_access").upsert(
        { workspace_id: ctx.workspace.id, membership_id: ctx.membership.id, mailbox_id: mb.id, permission: "read_send" },
        { onConflict: "membership_id,mailbox_id" },
      );
      await writeAudit(admin, {
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "mailbox_access.granted",
        resourceType: "mailbox_access",
        resourceId: mb.id,
        metadata: { mailbox_id: mb.id, membership_id: ctx.membership.id, user_id: ctx.user.id, permission: "read_send", self: true },
      });
    }
    refresh(slug, "mailboxes");
    revalidatePath(`/w/${slug}`, "layout");
    return ok(`Created ${address}. Nobody can read it until you grant access.`);
  });
}

export async function toggleMailboxAction(slug: string, mailboxId: string, enabled: boolean, formData: FormData): Promise<void> {
  void formData;
  const ctx = await requireWorkspaceAction({ slug }, "admin");
  const admin = createAdminClient();
  const { data } = await admin.from("mailboxes").update({ enabled }).eq("id", mailboxId).eq("workspace_id", ctx.workspace.id).select("id, address").maybeSingle();
  if (!data) throw new Error("Mailbox not found");
  await writeAudit(admin, {
    workspaceId: ctx.workspace.id,
    actorUserId: ctx.user.id,
    action: enabled ? "mailbox.enabled" : "mailbox.disabled",
    resourceType: "mailbox",
    resourceId: mailboxId,
    metadata: { address: data.address },
  });
  refresh(slug, "mailboxes");
  revalidatePath(`/w/${slug}`, "layout");
}

/** Grant, change or revoke one member's access to one mailbox. Always audited. */
export async function setMailboxGrantAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return guarded(async () => {
    const slug = formString(formData, "slug");
    const mailboxId = formString(formData, "mailboxId");
    const membershipId = formString(formData, "membershipId");
    const permission = formString(formData, "permission");
    if (!["none", "read", "read_send"].includes(permission)) return fail("Choose an access level.");

    const ctx = await requireWorkspaceAction({ slug }, "admin");
    const admin = createAdminClient();
    const [{ data: mailbox }, { data: target }] = await Promise.all([
      admin.from("mailboxes").select("id, address").eq("id", mailboxId).eq("workspace_id", ctx.workspace.id).maybeSingle(),
      admin.from("workspace_memberships").select("id, role, user_id").eq("id", membershipId).eq("workspace_id", ctx.workspace.id).maybeSingle(),
    ]);
    if (!mailbox || !target) return fail("Mailbox or member not found.");
    if (target.user_id !== ctx.user.id && !canManageRole(ctx.role, target.role)) {
      return fail("Admins can't change an owner's mailbox access.");
    }

    const { data: existing } = await admin
      .from("mailbox_access")
      .select("id, permission")
      .eq("membership_id", membershipId)
      .eq("mailbox_id", mailboxId)
      .maybeSingle();
    const previous = existing?.permission ?? "none";
    if (previous === permission) return ok("No change.");

    if (permission === "none") {
      await admin.from("mailbox_access").delete().eq("membership_id", membershipId).eq("mailbox_id", mailboxId);
    } else {
      const { error } = await admin.from("mailbox_access").upsert(
        { workspace_id: ctx.workspace.id, membership_id: membershipId, mailbox_id: mailboxId, permission: permission as MailboxPermission },
        { onConflict: "membership_id,mailbox_id" },
      );
      if (error) throw new Error(error.message);
    }
    await writeAudit(admin, {
      workspaceId: ctx.workspace.id,
      actorUserId: ctx.user.id,
      action: permission === "none" ? "mailbox_access.revoked" : previous === "none" ? "mailbox_access.granted" : "mailbox_access.changed",
      resourceType: "mailbox_access",
      resourceId: mailboxId,
      metadata: { mailbox_id: mailboxId, address: mailbox.address, membership_id: membershipId, user_id: target.user_id, from: previous, to: permission },
    });
    refresh(slug, "mailboxes");
    revalidatePath(`/w/${slug}`, "layout");
    return ok(permission === "none" ? "Access removed" : "Access saved");
  });
}

// =========================== team ===========================
export async function inviteMemberAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return guarded(async () => {
    const slug = formString(formData, "slug");
    const ctx = await requireWorkspaceAction({ slug }, "admin");
    const parsed = z
      .object({ email: z.string().trim().toLowerCase().email("Enter a valid email address"), role: z.enum(["admin", "member"]) })
      .safeParse({ email: formData.get("email"), role: formData.get("role") });
    if (!parsed.success) return fail("Check the highlighted fields.", zodFields(parsed.error));
    if (!canManageRole(ctx.role, parsed.data.role)) return fail("You can't invite someone at that role.");

    const admin = createAdminClient();
    const { data: profile } = await admin.from("profiles").select("id").eq("email", parsed.data.email).maybeSingle();
    if (profile) {
      const { data: m } = await admin.from("workspace_memberships").select("id").eq("workspace_id", ctx.workspace.id).eq("user_id", profile.id).maybeSingle();
      if (m) return fail(`${parsed.data.email} is already a member.`, { email: "Already a member" });
    }
    await admin
      .from("workspace_invitations")
      .update({ revoked_at: new Date().toISOString() })
      .eq("workspace_id", ctx.workspace.id)
      .eq("email", parsed.data.email)
      .is("accepted_at", null)
      .is("revoked_at", null);
    const { token, tokenHash } = generateInviteToken();
    const { data: inv, error } = await admin
      .from("workspace_invitations")
      .insert({
        workspace_id: ctx.workspace.id,
        email: parsed.data.email,
        role: parsed.data.role,
        token_hash: tokenHash,
        expires_at: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000).toISOString(),
        invited_by: ctx.user.id,
      })
      .select("id")
      .single();
    if (error || !inv) throw new Error(error?.message ?? "invite failed");
    await writeAudit(admin, { workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "invitation.created", resourceType: "workspace_invitation", resourceId: inv.id, metadata: { email: parsed.data.email, role: parsed.data.role } });
    refresh(slug, "team");
    const origin = await getRequestAppUrl();
    return ok("Invitation created. Send this link to them — it works once and is shown only now.", {
      reveal: {
        label: `Invite link for ${parsed.data.email}`,
        value: `${origin}/invite/${token}`,
        note: `Expires in ${INVITE_TTL_DAYS} days. They must sign in with ${parsed.data.email}.`,
      },
    });
  });
}

export async function revokeInvitationAction(slug: string, invitationId: string, formData: FormData): Promise<void> {
  void formData;
  const ctx = await requireWorkspaceAction({ slug }, "admin");
  const admin = createAdminClient();
  await admin
    .from("workspace_invitations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", invitationId)
    .eq("workspace_id", ctx.workspace.id)
    .is("accepted_at", null);
  await writeAudit(admin, { workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "invitation.revoked", resourceType: "workspace_invitation", resourceId: invitationId });
  refresh(slug, "team");
}

async function ownerCount(workspaceId: string): Promise<number> {
  const { count } = await createAdminClient()
    .from("workspace_memberships")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("role", "owner");
  return count ?? 0;
}

export async function changeRoleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return guarded(async () => {
    const slug = formString(formData, "slug");
    const membershipId = formString(formData, "membershipId");
    const role = formString(formData, "role") as WorkspaceRole;
    if (!["owner", "admin", "member"].includes(role)) return fail("Choose a role.");
    const ctx = await requireWorkspaceAction({ slug }, "admin");
    const admin = createAdminClient();
    const { data: target } = await admin.from("workspace_memberships").select("id, role, user_id").eq("id", membershipId).eq("workspace_id", ctx.workspace.id).maybeSingle();
    if (!target) return fail("Member not found.");
    if (target.role === role) return ok("No change.");
    if (!canManageRole(ctx.role, target.role) || !canManageRole(ctx.role, role)) {
      return fail("Only owners can change owner roles.");
    }
    if (target.role === "owner" && role !== "owner" && (await ownerCount(ctx.workspace.id)) <= 1) {
      return fail("A workspace needs at least one owner. Promote someone else first.");
    }
    const { error } = await admin.from("workspace_memberships").update({ role }).eq("id", membershipId);
    if (error) return fail(error.code === "23514" ? "A workspace needs at least one owner." : "Couldn't update the role.");
    await writeAudit(admin, { workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "member.role_changed", resourceType: "workspace_membership", resourceId: membershipId, metadata: { user_id: target.user_id, from: target.role, to: role } });
    refresh(slug, "team");
    revalidatePath(`/w/${slug}`, "layout");
    return ok("Role updated");
  });
}

export async function removeMemberAction(formData: FormData): Promise<void> {
  const slug = formString(formData, "slug");
  const membershipId = formString(formData, "membershipId");
  const ctx = await requireWorkspaceAction({ slug }, "admin");
  const admin = createAdminClient();
  const { data: target } = await admin.from("workspace_memberships").select("id, role, user_id").eq("id", membershipId).eq("workspace_id", ctx.workspace.id).maybeSingle();
  if (!target) return;
  if (target.user_id === ctx.user.id) throw new Error("You can't remove yourself. Ask another owner.");
  if (!canManageRole(ctx.role, target.role)) throw new Error("Only owners can remove an owner.");
  if (target.role === "owner" && (await ownerCount(ctx.workspace.id)) <= 1) {
    throw new Error("A workspace needs at least one owner.");
  }
  const { error } = await admin.from("workspace_memberships").delete().eq("id", membershipId);
  if (error) throw new Error(error.message);
  await writeAudit(admin, { workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "member.removed", resourceType: "workspace_membership", resourceId: membershipId, metadata: { user_id: target.user_id, role: target.role } });
  refresh(slug, "team");
  refresh(slug, "mailboxes");
}

// =========================== templates ===========================
const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
function extractVariables(...parts: string[]): string[] {
  const set = new Set<string>();
  for (const p of parts) for (const m of p.matchAll(VAR_RE)) set.add(m[1]);
  return [...set];
}

export async function saveTemplateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return guarded(async () => {
    const slug = formString(formData, "slug");
    const ctx = await requireWorkspaceAction({ slug }, "admin");
    const parsed = z
      .object({
        name: z.string().trim().min(1, "Give it a name").max(120),
        subject: z.string().trim().max(300),
        body: z.string().max(50_000),
      })
      .safeParse({ name: formData.get("name"), subject: formData.get("subject"), body: formData.get("body") });
    if (!parsed.success) return fail("Check the highlighted fields.", zodFields(parsed.error));
    const v = parsed.data;
    const row = {
      name: v.name,
      subject: v.subject,
      body_text: v.body,
      body_html: textToHtml(v.body),
      variables: extractVariables(v.subject, v.body) as unknown as Json,
    };
    const templateId = formString(formData, "templateId");
    const admin = createAdminClient();
    if (templateId) {
      const { data, error } = await ctx.supabase.from("email_templates").update(row).eq("id", templateId).eq("workspace_id", ctx.workspace.id).select("id").maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return fail("Template not found.");
      await writeAudit(admin, { workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "template.updated", resourceType: "email_template", resourceId: templateId });
    } else {
      const { data, error } = await ctx.supabase.from("email_templates").insert({ workspace_id: ctx.workspace.id, ...row }).select("id").single();
      if (error || !data) throw new Error(error?.message ?? "insert failed");
      await writeAudit(admin, { workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "template.created", resourceType: "email_template", resourceId: data.id });
    }
    refresh(slug, "templates");
    return ok(templateId ? "Template saved" : "Template created");
  });
}

export async function deleteTemplateAction(slug: string, templateId: string, formData: FormData): Promise<void> {
  void formData;
  const ctx = await requireWorkspaceAction({ slug }, "admin");
  const { error } = await ctx.supabase.from("email_templates").delete().eq("id", templateId).eq("workspace_id", ctx.workspace.id);
  if (error) throw new Error(error.message);
  await writeAudit(createAdminClient(), { workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "template.deleted", resourceType: "email_template", resourceId: templateId });
  refresh(slug, "templates");
}

// =========================== AI assist ===========================
export async function saveAiSettingsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return guarded(async () => {
    const slug = formString(formData, "slug");
    const ctx = await requireWorkspaceAction({ slug }, "admin");
    const enabled = formData.get("aiEnabled") === "on";
    const instructionsRaw = formString(formData, "aiInstructions");
    const limitParsed = z.coerce.number().int().min(0).max(100_000).safeParse(formData.get("monthlyAiLimit"));
    if (!limitParsed.success) return fail("Enter a valid monthly AI limit.", { monthlyAiLimit: "0–100000" });
    if (instructionsRaw.length > 2000) return fail("Instructions are too long (max 2000 characters).", { aiInstructions: "Too long" });

    const { data, error } = await ctx.supabase
      .from("workspaces")
      .update({
        ai_enabled: enabled,
        ai_instructions: instructionsRaw || null,
        monthly_ai_limit: limitParsed.data,
      })
      .eq("id", ctx.workspace.id)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return fail("Could not update AI settings.");

    await writeAudit(createAdminClient(), {
      workspaceId: ctx.workspace.id,
      actorUserId: ctx.user.id,
      action: enabled ? "ai.enabled" : "ai.disabled",
      resourceType: "workspace",
      resourceId: ctx.workspace.id,
      metadata: { ai_enabled: enabled, monthly_ai_limit: limitParsed.data, has_instructions: Boolean(instructionsRaw) },
    });
    refresh(slug, "ai");
    revalidatePath(`/w/${slug}`, "layout");
    return ok(enabled ? "AI assist is on for this workspace." : "AI assist is off.");
  });
}

// =========================== integrations ===========================
export async function createIntegrationAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return guarded(async () => {
    const slug = formString(formData, "slug");
    const ctx = await requireWorkspaceAction({ slug }, "admin");
    const name = z.string().trim().min(1, "Name the integration").max(120).safeParse(formData.get("name"));
    if (!name.success) return fail("Name the integration.", { name: "Required" });
    const allowed = formString(formData, "allowedMailboxId") || null;
    const admin = createAdminClient();
    if (allowed) {
      const { data: mb } = await admin.from("mailboxes").select("id").eq("id", allowed).eq("workspace_id", ctx.workspace.id).maybeSingle();
      if (!mb) return fail("Pick one of this workspace's mailboxes.", { allowedMailboxId: "Invalid mailbox" });
    }
    const key = generateApiKey();
    const { data, error } = await admin
      .from("app_integrations")
      .insert({ workspace_id: ctx.workspace.id, name: name.data, allowed_mailbox_id: allowed, key_hash: key.keyHash, key_prefix: key.keyPrefix, created_by: ctx.user.id })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message ?? "insert failed");
    await writeAudit(admin, { workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "integration.created", resourceType: "app_integration", resourceId: data.id, metadata: { name: name.data, key_prefix: key.keyPrefix, mailbox_id: allowed } });
    refresh(slug, "integrations");
    return ok("API key created.", { reveal: { label: "Copy your API key now", value: key.key, note: "We store only a hash, so this is the only time it can be shown. Treat it like a password." } });
  });
}

export async function revokeIntegrationAction(slug: string, integrationId: string, formData: FormData): Promise<void> {
  void formData;
  const ctx = await requireWorkspaceAction({ slug }, "admin");
  const admin = createAdminClient();
  const { data } = await admin
    .from("app_integrations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", integrationId)
    .eq("workspace_id", ctx.workspace.id)
    .is("revoked_at", null)
    .select("id, key_prefix")
    .maybeSingle();
  if (data) {
    await writeAudit(admin, { workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "integration.revoked", resourceType: "app_integration", resourceId: integrationId, metadata: { key_prefix: data.key_prefix } });
  }
  refresh(slug, "integrations");
}
