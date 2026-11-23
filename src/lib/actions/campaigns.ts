"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { requireMailboxAccess, roleAtLeast } from "@/lib/auth/authz";
import { requireWorkspaceAction } from "@/lib/data/workspace";
import { CampaignError, parseContactsCsv, startCampaign } from "@/lib/email/campaigns";
import { textToHtml } from "@/lib/email/sanitize";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/types/database";
import { formString, guarded } from "./guard";
import { fail, ok, type ActionState } from "./state";

function refresh(slug: string, path = "") {
  revalidatePath(`/w/${slug}/campaigns${path}`);
}

function zodFields(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of error.issues) out[String(i.path[0] ?? "form")] ??= i.message;
  return out;
}

// ---- lists ------------------------------------------------------------------
export async function createAudienceListAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return guarded(async () => {
    const slug = formString(formData, "slug");
    const ctx = await requireWorkspaceAction({ slug }, "admin");
    const name = z.string().trim().min(1, "Name the list").max(120).safeParse(formData.get("name"));
    if (!name.success) return fail("Name the list.", { name: "Required" });
    const description = formString(formData, "description").slice(0, 500) || null;

    const { data, error } = await ctx.supabase
      .from("audience_lists")
      .insert({
        workspace_id: ctx.workspace.id,
        name: name.data,
        description,
        created_by: ctx.user.id,
      })
      .select("id")
      .single();
    if (error || !data) {
      if (error?.code === "23505") return fail("A list with that name already exists.", { name: "Already exists" });
      throw new Error(error?.message ?? "insert failed");
    }
    await writeAudit(createAdminClient(), {
      workspaceId: ctx.workspace.id,
      actorUserId: ctx.user.id,
      action: "audience_list.created",
      resourceType: "audience_list",
      resourceId: data.id,
      metadata: { name: name.data },
    });
    refresh(slug);
    redirect(`/w/${slug}/campaigns/lists/${data.id}`);
  });
}

export async function importContactsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return guarded(async () => {
    const slug = formString(formData, "slug");
    const listId = formString(formData, "listId");
    const ctx = await requireWorkspaceAction({ slug }, "admin");

    const { data: list } = await ctx.supabase
      .from("audience_lists")
      .select("id")
      .eq("id", listId)
      .eq("workspace_id", ctx.workspace.id)
      .maybeSingle();
    if (!list) return fail("List not found.");

    const file = formData.get("csv");
    let raw = formString(formData, "csvText");
    if (file instanceof File && file.size > 0) {
      raw = await file.text();
    }
    const { contacts, errors } = parseContactsCsv(raw);
    if (!contacts.length) {
      return fail(errors[0] ?? "No valid contacts found in the CSV.");
    }

    const { count: existing } = await ctx.supabase
      .from("audience_contacts")
      .select("id", { count: "exact", head: true })
      .eq("list_id", listId);
    if ((existing ?? 0) + contacts.length > 5000) {
      return fail(`This import would exceed the 5,000 contact limit (list has ${existing ?? 0}).`);
    }

    const admin = createAdminClient();
    const rows = contacts.map((c) => ({
      workspace_id: ctx.workspace.id,
      list_id: listId,
      email: c.email,
      full_name: c.fullName,
      fields: c.fields as unknown as Json,
    }));
    // Upsert in chunks
    let upserted = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error } = await admin.from("audience_contacts").upsert(chunk, { onConflict: "list_id,email" });
      if (error) throw new Error(error.message);
      upserted += chunk.length;
    }

    await writeAudit(admin, {
      workspaceId: ctx.workspace.id,
      actorUserId: ctx.user.id,
      action: "audience_list.imported",
      resourceType: "audience_list",
      resourceId: listId,
      metadata: { upserted, parse_errors: errors.length },
    });
    refresh(slug, `/lists/${listId}`);
    const note = errors.length ? ` Imported with ${errors.length} row warning(s).` : "";
    return ok(`Imported ${upserted} contact${upserted === 1 ? "" : "s"}.${note}`);
  });
}

export async function deleteAudienceListAction(slug: string, listId: string, formData: FormData): Promise<void> {
  void formData;
  const ctx = await requireWorkspaceAction({ slug }, "admin");
  const { error } = await ctx.supabase.from("audience_lists").delete().eq("id", listId).eq("workspace_id", ctx.workspace.id);
  if (error) {
    if (error.code === "23503") throw new Error("Remove or finish campaigns that use this list first.");
    throw new Error(error.message);
  }
  await writeAudit(createAdminClient(), {
    workspaceId: ctx.workspace.id,
    actorUserId: ctx.user.id,
    action: "audience_list.deleted",
    resourceType: "audience_list",
    resourceId: listId,
  });
  refresh(slug);
  redirect(`/w/${slug}/campaigns`);
}

export async function deleteContactAction(slug: string, listId: string, contactId: string, formData: FormData): Promise<void> {
  void formData;
  const ctx = await requireWorkspaceAction({ slug }, "admin");
  await ctx.supabase.from("audience_contacts").delete().eq("id", contactId).eq("list_id", listId).eq("workspace_id", ctx.workspace.id);
  refresh(slug, `/lists/${listId}`);
}

// ---- campaigns --------------------------------------------------------------
export async function createCampaignAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return guarded(async () => {
    const slug = formString(formData, "slug");
    const ctx = await requireWorkspaceAction({ slug }, "member");
    const parsed = z
      .object({
        name: z.string().trim().min(1, "Name the campaign").max(120),
        listId: z.string().uuid("Pick a list"),
        mailboxId: z.string().uuid("Pick a mailbox"),
        subject: z.string().trim().min(1, "Subject is required").max(300),
        body: z.string().trim().min(1, "Write a message").max(50_000),
        scheduleAt: z.string().optional(),
      })
      .safeParse({
        name: formData.get("name"),
        listId: formData.get("listId"),
        mailboxId: formData.get("mailboxId"),
        subject: formData.get("subject"),
        body: formData.get("body"),
        scheduleAt: formString(formData, "scheduleAt") || undefined,
      });
    if (!parsed.success) return fail("Check the highlighted fields.", zodFields(parsed.error));
    const v = parsed.data;

    await requireMailboxAccess(ctx.supabase, ctx.user.id, v.mailboxId, "send");

    const { data: list } = await ctx.supabase
      .from("audience_lists")
      .select("id")
      .eq("id", v.listId)
      .eq("workspace_id", ctx.workspace.id)
      .maybeSingle();
    if (!list) return fail("Pick one of this workspace's lists.", { listId: "Invalid list" });

    const scheduleRaw = v.scheduleAt?.trim();
    let scheduledAt: string | null = null;
    let status: "draft" | "scheduled" = "draft";
    if (scheduleRaw) {
      const d = new Date(scheduleRaw);
      if (Number.isNaN(d.getTime())) return fail("Invalid schedule time.", { scheduleAt: "Invalid" });
      if (d.getTime() < Date.now() - 60_000) return fail("Schedule a time in the future.", { scheduleAt: "Must be in the future" });
      scheduledAt = d.toISOString();
      status = "scheduled";
    }

    const { data, error } = await ctx.supabase
      .from("campaigns")
      .insert({
        workspace_id: ctx.workspace.id,
        list_id: v.listId,
        mailbox_id: v.mailboxId,
        name: v.name,
        subject: v.subject,
        body_text: v.body,
        body_html: textToHtml(v.body),
        status,
        scheduled_at: scheduledAt,
        created_by: ctx.user.id,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message ?? "insert failed");

    await writeAudit(createAdminClient(), {
      workspaceId: ctx.workspace.id,
      actorUserId: ctx.user.id,
      action: "campaign.created",
      resourceType: "campaign",
      resourceId: data.id,
      metadata: { status, list_id: v.listId, mailbox_id: v.mailboxId },
    });
    refresh(slug);
    redirect(`/w/${slug}/campaigns/${data.id}`);
  });
}

export async function startCampaignAction(slug: string, campaignId: string, formData: FormData): Promise<void> {
  void formData;
  const ctx = await requireWorkspaceAction({ slug }, "member");
  const { data: campaign } = await ctx.supabase
    .from("campaigns")
    .select("id, mailbox_id, status")
    .eq("id", campaignId)
    .eq("workspace_id", ctx.workspace.id)
    .maybeSingle();
  if (!campaign) throw new Error("Campaign not found");
  await requireMailboxAccess(ctx.supabase, ctx.user.id, campaign.mailbox_id, "send");

  try {
    await startCampaign(createAdminClient(), {
      campaignId,
      workspaceId: ctx.workspace.id,
      actorUserId: ctx.user.id,
      when: "now",
    });
  } catch (e) {
    if (e instanceof CampaignError) throw new Error(e.message);
    throw e;
  }
  refresh(slug);
  refresh(slug, `/${campaignId}`);
}

export async function cancelCampaignAction(slug: string, campaignId: string, formData: FormData): Promise<void> {
  void formData;
  const ctx = await requireWorkspaceAction({ slug }, "member");
  const admin = createAdminClient();
  const { data: campaign } = await admin
    .from("campaigns")
    .select("id, mailbox_id, status")
    .eq("id", campaignId)
    .eq("workspace_id", ctx.workspace.id)
    .maybeSingle();
  if (!campaign) throw new Error("Campaign not found");
  if (!["draft", "scheduled", "sending", "paused"].includes(campaign.status)) {
    throw new Error("This campaign can no longer be cancelled");
  }
  if (!roleAtLeast(ctx.role, "admin")) {
    await requireMailboxAccess(ctx.supabase, ctx.user.id, campaign.mailbox_id, "send");
  }

  await admin
    .from("campaigns")
    .update({ status: "cancelled", completed_at: new Date().toISOString(), scheduled_at: null })
    .eq("id", campaignId);
  // Drop unsent recipients
  await admin.from("campaign_recipients").delete().eq("campaign_id", campaignId).in("status", ["pending", "queued"]);

  await writeAudit(admin, {
    workspaceId: ctx.workspace.id,
    actorUserId: ctx.user.id,
    action: "campaign.cancelled",
    resourceType: "campaign",
    resourceId: campaignId,
  });
  refresh(slug);
  refresh(slug, `/${campaignId}`);
}

export async function resumeCampaignAction(slug: string, campaignId: string, formData: FormData): Promise<void> {
  void formData;
  const ctx = await requireWorkspaceAction({ slug }, "member");
  const { data: campaign } = await ctx.supabase
    .from("campaigns")
    .select("id, mailbox_id, status")
    .eq("id", campaignId)
    .eq("workspace_id", ctx.workspace.id)
    .maybeSingle();
  if (!campaign || campaign.status !== "paused") throw new Error("Only paused campaigns can be resumed");
  await requireMailboxAccess(ctx.supabase, ctx.user.id, campaign.mailbox_id, "send");
  await createAdminClient().from("campaigns").update({ status: "sending" }).eq("id", campaignId);
  await writeAudit(createAdminClient(), {
    workspaceId: ctx.workspace.id,
    actorUserId: ctx.user.id,
    action: "campaign.resumed",
    resourceType: "campaign",
    resourceId: campaignId,
  });
  refresh(slug, `/${campaignId}`);
}
