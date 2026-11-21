"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireMailboxAccess } from "@/lib/auth/authz";
import { requireWorkspaceAction } from "@/lib/data/workspace";
import { createAdminClient } from "@/lib/supabase/admin";

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
