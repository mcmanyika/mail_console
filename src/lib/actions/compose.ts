"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { requireMailboxAccess } from "@/lib/auth/authz";
import { requireWorkspaceAction, formatFrom } from "@/lib/data/workspace";
import { getMaxAttachmentBytes } from "@/lib/env";
import { enqueueOutboundMessage, processOutbox } from "@/lib/email/outbox";
import { makeSnippet, textToHtml } from "@/lib/email/sanitize";
import { buildReplyHeaders, generateRfcMessageId } from "@/lib/email/threading";
import { parseRecipients } from "@/lib/format";
import { getEmailAdapter } from "@/lib/resend";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit";
import { formString, guarded } from "./guard";
import { fail, ok, type ActionState } from "./state";

const MAX_SUBJECT = 300;
const MAX_BODY = 200_000;

export type ComposeMode = "new" | "reply" | "replyAll" | "forward" | "resend";

function safeFilename(name: string): string {
  const cleaned = name.replace(/[/\\]/g, "_").replace(/[^\w.\- ()]/g, "_").trim().slice(0, 120);
  return cleaned || "attachment";
}

const withDraft = (state: ActionState, draftId: string | undefined): ActionState =>
  draftId ? { ...state, data: { ...(state.data ?? {}), draftId } } : state;

/**
 * Save a draft or send. One action, two intents:
 *   intent=draft  -> upsert the caller's draft (+ recipients + attachments)
 *   intent=send   -> save, then enqueue through the transactional outbox
 * Authorization: the caller must hold a read_send grant on the chosen mailbox
 * (requireMailboxAccess) — workspace role alone is never enough.
 */
export async function composeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let redirectTo: string | null = null;
  let draftId: string | undefined = formString(formData, "draftId") || undefined;

  const result = await guarded(async () => {
    const slug = formString(formData, "slug");
    const intent = formString(formData, "intent") === "send" ? "send" : "draft";
    const mode = (formString(formData, "mode") || "new") as ComposeMode;
    const parentId = formString(formData, "parentId") || undefined;
    const mailboxId = formString(formData, "mailboxId");

    const ctx = await requireWorkspaceAction({ slug });
    if (!mailboxId) return fail("Choose a mailbox to send from.", { mailboxId: "Required" });
    const access = await requireMailboxAccess(ctx.supabase, ctx.user.id, mailboxId, "send");

    const to = parseRecipients(formString(formData, "to"));
    const cc = parseRecipients(formString(formData, "cc"));
    const bcc = parseRecipients(formString(formData, "bcc"));
    const fieldErrors: Record<string, string> = {};
    if (to.invalid.length) fieldErrors.to = `Not a valid address: ${to.invalid[0]}`;
    if (cc.invalid.length) fieldErrors.cc = `Not a valid address: ${cc.invalid[0]}`;
    if (bcc.invalid.length) fieldErrors.bcc = `Not a valid address: ${bcc.invalid[0]}`;

    const subject = formString(formData, "subject").slice(0, MAX_SUBJECT);
    const body = (typeof formData.get("body") === "string" ? (formData.get("body") as string) : "").replace(/\r\n/g, "\n");
    if (body.length > MAX_BODY) fieldErrors.body = "Message is too long";

    const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    const removeIds = formData.getAll("removeAttachment").filter((v): v is string => typeof v === "string");
    const forwardIds = formData.getAll("forwardAttachment").filter((v): v is string => typeof v === "string");

    if (intent === "send") {
      if (to.valid.length === 0 && !fieldErrors.to) fieldErrors.to = "Add at least one recipient";
      if (!subject) fieldErrors.subject = "Add a subject";
      if (!body.trim() && files.length === 0 && forwardIds.length === 0 && !draftId) fieldErrors.body = "Write a message or attach a file";
    }
    if (Object.keys(fieldErrors).length) return fail("Check the highlighted fields.", fieldErrors);

    // Dedupe across types: To wins over Cc wins over Bcc.
    const toSet = new Set(to.valid);
    const ccList = cc.valid.filter((a) => !toSet.has(a));
    const ccSet = new Set(ccList);
    const bccList = bcc.valid.filter((a) => !toSet.has(a) && !ccSet.has(a));

    const admin = createAdminClient();
    const supabase = ctx.supabase;
    const fromAddress = formatFrom({ address: access.mailbox.address, displayName: access.mailbox.display_name });
    const bodyFields = {
      subject,
      text_body: body,
      html_body: textToHtml(body),
      snippet: makeSnippet({ text: body }),
      from_address: fromAddress,
    };

    // ---- resolve / create the draft ----
    let threadId: string | null = null;
    let inReplyTo: string | null = null;
    let references: string | null = null;
    let sourceMessageId: string | null = null;

    if (draftId) {
      const { data: existing } = await supabase
        .from("messages")
        .select("id, mailbox_id, thread_id, in_reply_to, references_header, workspace_id")
        .eq("id", draftId)
        .eq("direction", "draft")
        .eq("author_user_id", ctx.user.id)
        .maybeSingle();
      if (!existing || existing.workspace_id !== ctx.workspace.id) {
        draftId = undefined;
        return fail("This draft no longer exists — it may already have been sent or deleted.");
      }
      if (existing.thread_id && existing.mailbox_id !== mailboxId) {
        return fail("A reply must be sent from the mailbox it belongs to.", { mailboxId: "Can't change for a reply" });
      }
      threadId = existing.thread_id;
      inReplyTo = existing.in_reply_to;
      references = existing.references_header;
      const { error } = await supabase
        .from("messages")
        .update({ mailbox_id: mailboxId, ...bodyFields })
        .eq("id", draftId)
        .eq("author_user_id", ctx.user.id);
      if (error) throw new Error(error.message);
    } else {
      if (parentId && mode !== "new") {
        // RLS only returns the parent if the caller can read its mailbox.
        const { data: parent } = await supabase
          .from("messages")
          .select("id, mailbox_id, thread_id, rfc_message_id, in_reply_to, references_header, workspace_id")
          .eq("id", parentId)
          .maybeSingle();
        if (!parent || parent.workspace_id !== ctx.workspace.id) return fail("The original message could not be found.");
        if (mode !== "forward" && parent.mailbox_id !== mailboxId) {
          return fail("Replies must be sent from the mailbox that holds the conversation.", { mailboxId: "Can't change for a reply" });
        }
        sourceMessageId = parent.id;
        if (mode === "reply" || mode === "replyAll") {
          threadId = parent.thread_id;
          const h = buildReplyHeaders({
            rfcMessageId: parent.rfc_message_id,
            referencesHeader: parent.references_header,
            inReplyTo: parent.in_reply_to,
          });
          inReplyTo = h.inReplyTo;
          references = h.references;
        } else if (mode === "resend" && parent.mailbox_id === mailboxId) {
          threadId = parent.thread_id;
          inReplyTo = parent.in_reply_to;
          references = parent.references_header;
        }
      }
      const { data: created, error } = await supabase
        .from("messages")
        .insert({
          workspace_id: ctx.workspace.id,
          mailbox_id: mailboxId,
          thread_id: threadId,
          direction: "draft",
          lifecycle_state: "draft",
          author_user_id: ctx.user.id,
          in_reply_to: inReplyTo,
          references_header: references,
          ...bodyFields,
        })
        .select("id")
        .single();
      if (error || !created) throw new Error(error?.message ?? "could not create draft");
      draftId = created.id;
    }
    const messageId = draftId as string;

    // ---- recipients (replace set) ----
    const { error: delErr } = await supabase.from("message_recipients").delete().eq("message_id", messageId);
    if (delErr) throw new Error(delErr.message);
    const rows = [
      ...to.valid.map((address) => ({ address, type: "to" as const })),
      ...ccList.map((address) => ({ address, type: "cc" as const })),
      ...bccList.map((address) => ({ address, type: "bcc" as const })),
    ].map((r) => ({ ...r, message_id: messageId, workspace_id: ctx.workspace.id }));
    if (rows.length) {
      const { error } = await supabase.from("message_recipients").insert(rows);
      if (error) throw new Error(error.message);
    }

    // ---- attachments ----
    const storage = admin.storage.from("attachments");
    const { data: current } = await admin.from("attachments").select("id, storage_path, size_bytes").eq("message_id", messageId);
    let attachments = current ?? [];

    const removing = attachments.filter((a) => removeIds.includes(a.id));
    if (removing.length) {
      await admin.from("attachments").delete().in("id", removing.map((a) => a.id));
      await storage.remove(removing.map((a) => a.storage_path)).catch(() => undefined);
      attachments = attachments.filter((a) => !removing.includes(a));
    }
    const maxBytes = getMaxAttachmentBytes();
    let total = attachments.reduce((n, a) => n + Number(a.size_bytes), 0);

    if (sourceMessageId && forwardIds.length) {
      // Copy from the source message's attachments (RLS proves the caller can read them).
      const { data: src } = await supabase
        .from("attachments")
        .select("id, storage_path, filename, mime_type, size_bytes, content_id")
        .eq("message_id", sourceMessageId)
        .in("id", forwardIds);
      for (const a of src ?? []) {
        total += Number(a.size_bytes);
        if (total > maxBytes) return withDraft(fail(`Attachments are over the ${Math.round(maxBytes / 1048576)} MB limit.`), draftId);
        const dest = `${ctx.workspace.id}/${messageId}/${randomUUID()}-${safeFilename(a.filename)}`;
        const { error: cpErr } = await storage.copy(a.storage_path, dest);
        if (cpErr) throw new Error(`could not copy attachment: ${cpErr.message}`);
        const { data: row } = await admin
          .from("attachments")
          .insert({
            message_id: messageId,
            workspace_id: ctx.workspace.id,
            storage_path: dest,
            filename: a.filename,
            mime_type: a.mime_type,
            size_bytes: a.size_bytes,
          })
          .select("id, storage_path, size_bytes")
          .single();
        if (row) attachments.push(row);
      }
    }

    for (const file of files) {
      total += file.size;
      if (total > maxBytes) {
        return withDraft(fail(`Attachments are over the ${Math.round(maxBytes / 1048576)} MB limit. Remove a file and try again.`), draftId);
      }
      const dest = `${ctx.workspace.id}/${messageId}/${randomUUID()}-${safeFilename(file.name)}`;
      const { error: upErr } = await storage.upload(dest, file, { contentType: file.type || "application/octet-stream", upsert: false });
      if (upErr) throw new Error(`upload failed: ${upErr.message}`);
      const { data: row, error: insErr } = await admin
        .from("attachments")
        .insert({
          message_id: messageId,
          workspace_id: ctx.workspace.id,
          storage_path: dest,
          filename: file.name.slice(0, 200),
          mime_type: file.type || "application/octet-stream",
          size_bytes: file.size,
        })
        .select("id, storage_path, size_bytes")
        .single();
      if (insErr || !row) {
        await storage.remove([dest]).catch(() => undefined);
        throw new Error(insErr?.message ?? "attachment insert failed");
      }
      attachments.push(row);
    }

    const { data: attMeta } = await admin.from("attachments").select("id, filename, size_bytes").eq("message_id", messageId);
    const attData = (attMeta ?? []).map((a) => ({ id: a.id, filename: a.filename, size: Number(a.size_bytes) }));

    if (intent === "draft") {
      revalidatePath(`/w/${slug}`, "layout");
      return ok("Draft saved", { data: { draftId: messageId, savedAt: new Date().toISOString(), attachments: attData } });
    }

    // ---- send ----
    if (ctx.workspace.status !== "active") {
      return withDraft(fail("This workspace is suspended, so sending is paused. Your draft is saved."), messageId);
    }
    const domain = access.mailbox.address.split("@")[1];
    const enq = await enqueueOutboundMessage(admin, {
      messageId,
      idempotencyKey: `ui-send-${messageId}`,
      recipients: { to: to.valid, cc: ccList, bcc: bccList },
      rfcMessageId: generateRfcMessageId(domain),
      inReplyTo,
      references,
    });
    if (enq.status === "quota_exceeded") {
      return withDraft(
        fail(`Monthly sending limit reached (${enq.reserved + enq.settled} of ${enq.limit}). Your draft is saved — ask a platform admin to raise the limit.`),
        messageId,
      );
    }
    if (enq.status === "workspace_inactive") {
      return withDraft(fail("This workspace is suspended, so sending is paused. Your draft is saved."), messageId);
    }
    if (enq.status === "invalid") return withDraft(fail(enq.reason), messageId);

    await writeAudit(admin, {
      workspaceId: ctx.workspace.id,
      actorUserId: ctx.user.id,
      action: "message.queued",
      resourceType: "message",
      resourceId: messageId,
      metadata: { mailbox_id: mailboxId, recipients: to.valid.length + ccList.length + bccList.length, mode },
    });
    // Best-effort immediate delivery attempt (mock adapter in DEMO_MODE: nothing leaves the machine).
    after(async () => {
      try {
        await processOutbox(createAdminClient(), getEmailAdapter(), { batchSize: 5 });
      } catch (e) {
        console.error("[compose] inline outbox run failed", e);
      }
    });
    revalidatePath(`/w/${slug}`, "layout");
    redirectTo = `/w/${slug}/inbox?folder=inbox&thread=${enq.threadId}&queued=1`;
    return ok();
  });

  if (result.status === "success" && redirectTo) redirect(redirectTo);
  // Keep the draft id on errors so the client doesn't create duplicates on retry.
  return draftId && !result.data?.draftId ? withDraft(result, draftId) : result;
}
