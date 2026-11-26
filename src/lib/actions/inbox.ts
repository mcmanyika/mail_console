"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { writeAudit } from "@/lib/audit";
import { requireMailboxAccess } from "@/lib/auth/authz";
import { requireWorkspaceAction } from "@/lib/data/workspace";
import { createAdminClient } from "@/lib/supabase/admin";
import { formString } from "./guard";

function safeReturn(slug: string, to: string | undefined): string {
  const base = `/w/${slug}/inbox`;
  return to && to.startsWith(base) && !to.includes("//", 1) && !to.includes("\\") ? to : base;
}

async function setThreadState(slug: string, threadId: string, patch: { is_read?: boolean; is_archived?: boolean }) {
  const ctx = await requireWorkspaceAction({ slug });
  const { data: thread } = await ctx.supabase
    .from("threads")
    .select("id, mailbox_id, workspace_id")
    .eq("id", threadId)
    .maybeSingle();
  if (!thread || thread.workspace_id !== ctx.workspace.id) throw new Error("Conversation not found");
  await requireMailboxAccess(ctx.supabase, ctx.user.id, thread.mailbox_id, "read");
  const { error } = await ctx.supabase.from("thread_user_state").upsert(
    { workspace_id: ctx.workspace.id, thread_id: threadId, user_id: ctx.user.id, ...patch },
    { onConflict: "thread_id,user_id" },
  );
  if (error) throw new Error(error.message);
  revalidatePath(`/w/${slug}`, "layout");
}

/** Called from the reading pane when an unread conversation is opened. */
export async function markThreadReadAction(slug: string, threadId: string): Promise<void> {
  await setThreadState(slug, threadId, { is_read: true });
}

export async function markUnreadAction(slug: string, threadId: string, returnTo: string, formData: FormData): Promise<void> {
  void formData;
  await setThreadState(slug, threadId, { is_read: false });
  redirect(safeReturn(slug, returnTo));
}

export async function archiveThreadAction(
  slug: string,
  threadId: string,
  archived: boolean,
  returnTo: string,
  formData: FormData,
): Promise<void> {
  void formData;
  await setThreadState(slug, threadId, archived ? { is_archived: true, is_read: true } : { is_archived: false });
  redirect(safeReturn(slug, returnTo));
}

/** Delete one of the caller's own drafts (and its uploaded attachments). */
export async function discardDraftAction(slug: string, draftId: string, formData: FormData): Promise<void> {
  void formData;
  const ctx = await requireWorkspaceAction({ slug });
  const { data: draft } = await ctx.supabase
    .from("messages")
    .select("id, workspace_id")
    .eq("id", draftId)
    .eq("direction", "draft")
    .eq("author_user_id", ctx.user.id)
    .maybeSingle();
  if (draft && draft.workspace_id === ctx.workspace.id) {
    const { data: atts } = await ctx.supabase.from("attachments").select("storage_path").eq("message_id", draftId);
    const { error } = await ctx.supabase.from("messages").delete().eq("id", draftId).eq("author_user_id", ctx.user.id);
    if (error) throw new Error(error.message);
    if (atts?.length) {
      await createAdminClient()
        .storage.from("attachments")
        .remove(atts.map((a) => a.storage_path))
        .catch(() => undefined);
    }
  }
  revalidatePath(`/w/${slug}`, "layout");
  redirect(`/w/${slug}/inbox?folder=drafts`);
}

/**
 * Permanently delete a conversation (all messages + attachments) from a mailbox
 * the caller can read. Uses the service role after the grant check — RLS only
 * allows deleting one's own drafts.
 */
async function deleteThread(slug: string, threadId: string): Promise<void> {
  const ctx = await requireWorkspaceAction({ slug });
  const admin = createAdminClient();
  const { data: thread } = await admin
    .from("threads")
    .select("id, mailbox_id, workspace_id, subject")
    .eq("id", threadId)
    .eq("workspace_id", ctx.workspace.id)
    .maybeSingle();
  if (!thread) throw new Error("Conversation not found");

  await requireMailboxAccess(ctx.supabase, ctx.user.id, thread.mailbox_id, "read");

  const { data: messages } = await admin
    .from("messages")
    .select("id")
    .eq("thread_id", threadId)
    .eq("workspace_id", ctx.workspace.id);
  const messageIds = (messages ?? []).map((m) => m.id);

  let storagePaths: string[] = [];
  if (messageIds.length) {
    const { data: atts } = await admin.from("attachments").select("storage_path").in("message_id", messageIds);
    storagePaths = (atts ?? []).map((a) => a.storage_path).filter(Boolean);
  }

  const { error } = await admin.from("threads").delete().eq("id", threadId).eq("workspace_id", ctx.workspace.id);
  if (error) throw new Error(error.message);

  if (storagePaths.length) {
    await admin.storage
      .from("attachments")
      .remove(storagePaths)
      .catch(() => undefined);
  }

  await writeAudit(admin, {
    workspaceId: ctx.workspace.id,
    actorUserId: ctx.user.id,
    action: "thread.deleted",
    resourceType: "thread",
    resourceId: threadId,
    metadata: { mailboxId: thread.mailbox_id, messageCount: messageIds.length },
  });
}

export async function deleteThreadAction(formData: FormData): Promise<void> {
  const slug = formString(formData, "slug");
  const threadId = formString(formData, "threadId");
  const returnTo = formString(formData, "returnTo");
  if (!slug || !threadId) throw new Error("Missing conversation");

  await deleteThread(slug, threadId);
  revalidatePath(`/w/${slug}`, "layout");
  redirect(safeReturn(slug, returnTo || undefined));
}

function formIds(formData: FormData, name: string): string[] {
  return [...new Set(formData.getAll(name).map((v) => String(v).trim()).filter(Boolean))].slice(0, 100);
}

export async function bulkArchiveThreadsAction(formData: FormData): Promise<void> {
  const slug = formString(formData, "slug");
  const returnTo = formString(formData, "returnTo");
  const archived = formString(formData, "archived") === "1";
  const threadIds = formIds(formData, "threadId");
  if (!slug || threadIds.length === 0) throw new Error("Nothing selected");

  for (const threadId of threadIds) {
    await setThreadState(slug, threadId, archived ? { is_archived: true, is_read: true } : { is_archived: false });
  }
  redirect(safeReturn(slug, returnTo || undefined));
}

export async function bulkMarkUnreadAction(formData: FormData): Promise<void> {
  const slug = formString(formData, "slug");
  const returnTo = formString(formData, "returnTo");
  const threadIds = formIds(formData, "threadId");
  if (!slug || threadIds.length === 0) throw new Error("Nothing selected");

  for (const threadId of threadIds) {
    await setThreadState(slug, threadId, { is_read: false });
  }
  redirect(safeReturn(slug, returnTo || undefined));
}

export async function bulkDeleteThreadsAction(formData: FormData): Promise<void> {
  const slug = formString(formData, "slug");
  const returnTo = formString(formData, "returnTo");
  const threadIds = formIds(formData, "threadId");
  if (!slug || threadIds.length === 0) throw new Error("Nothing selected");

  for (const threadId of threadIds) {
    await deleteThread(slug, threadId);
  }
  revalidatePath(`/w/${slug}`, "layout");
  redirect(safeReturn(slug, returnTo || undefined));
}

export async function bulkDiscardDraftsAction(formData: FormData): Promise<void> {
  const slug = formString(formData, "slug");
  const draftIds = formIds(formData, "draftId");
  if (!slug || draftIds.length === 0) throw new Error("Nothing selected");

  const ctx = await requireWorkspaceAction({ slug });
  const admin = createAdminClient();
  for (const draftId of draftIds) {
    const { data: draft } = await ctx.supabase
      .from("messages")
      .select("id, workspace_id")
      .eq("id", draftId)
      .eq("direction", "draft")
      .eq("author_user_id", ctx.user.id)
      .maybeSingle();
    if (!draft || draft.workspace_id !== ctx.workspace.id) continue;
    const { data: atts } = await ctx.supabase.from("attachments").select("storage_path").eq("message_id", draftId);
    const { error } = await ctx.supabase.from("messages").delete().eq("id", draftId).eq("author_user_id", ctx.user.id);
    if (error) throw new Error(error.message);
    if (atts?.length) {
      await admin.storage
        .from("attachments")
        .remove(atts.map((a) => a.storage_path))
        .catch(() => undefined);
    }
  }
  revalidatePath(`/w/${slug}`, "layout");
  redirect(`/w/${slug}/inbox?folder=drafts`);
}
