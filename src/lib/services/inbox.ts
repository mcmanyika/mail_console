import { z } from "zod";
import { AuthzError, requireMailboxAccess } from "@/lib/auth/authz";
import type { AdminClient } from "@/lib/supabase/admin";
import type { AttachmentRow, MessageRow } from "@/lib/types/database";
import { extractAddress } from "@/lib/email/address";
import {
  ComposeError,
  assertContent,
  discardDraftRow,
  insertDraftMessage,
  normalizeRecipientLists,
  replaceRecipients,
  resolveSender,
  type RecipientLists,
} from "@/lib/email/compose";
import { enqueueOutboundMessage } from "@/lib/email/outbox";
import { htmlToText, makeSnippet, sanitizeEmailHtml, textToHtml } from "@/lib/email/sanitize";
import { buildReplyHeaders, generateRfcMessageId, looksLikeReply } from "@/lib/email/threading";

/**
 * Inbox operations for signed-in users. Every function:
 *   1. takes the AUTHENTICATED user id (never a client-supplied one),
 *   2. calls requireMailboxAccess() before touching message data
 *      (explicit mailbox grant for every role; `send` needs read_send),
 *   3. resolves the From header server-side from the approved mailbox.
 * Drafts are private to their author (a draft that isn't yours is a 404).
 */

export type InboxCtx = { admin: AdminClient; userId: string };

export class InboxError extends Error {
  constructor(
    readonly code: "not_found" | "quota_exceeded" | "workspace_suspended" | "invalid_request" | "conflict",
    message: string,
    readonly status: 400 | 404 | 409 | 422 | 429 | 403 = 422,
  ) {
    super(message);
    this.name = "InboxError";
  }
}

const uuid = z.uuid();
const addrs = z.array(z.string().max(254)).max(50).default([]);

export const draftInputSchema = z.object({
  draftId: uuid.optional(),
  mailboxId: uuid,
  to: addrs,
  cc: addrs,
  bcc: addrs,
  subject: z.string().max(998).default(""),
  text: z.string().max(256_000).default(""),
  html: z.string().max(512_000).optional(),
});
export type DraftInput = z.input<typeof draftInputSchema>;

// ---- loading with authorization -------------------------------------------------------------------------
async function loadMessage(ctx: InboxCtx, messageId: string, action: "read" | "send"): Promise<MessageRow> {
  if (!uuid.safeParse(messageId).success) throw new AuthzError("Message not found", 404);
  const { data, error } = await ctx.admin.from("messages").select("*").eq("id", messageId).maybeSingle();
  if (error) throw new Error(`message lookup failed: ${error.message}`);
  if (!data) throw new AuthzError("Message not found", 404);
  await requireMailboxAccess(ctx.admin, ctx.userId, data.mailbox_id, action);
  // Drafts are private to their author — indistinguishable from "doesn't exist" for everyone else.
  if (data.direction === "draft" && data.author_user_id !== ctx.userId) throw new AuthzError("Message not found", 404);
  return data;
}

async function loadOwnDraft(ctx: InboxCtx, draftId: string): Promise<MessageRow> {
  const draft = await loadMessage(ctx, draftId, "send");
  if (draft.direction !== "draft") throw new InboxError("conflict", "This message is no longer a draft", 409);
  return draft;
}

async function loadRecipients(admin: AdminClient, messageId: string): Promise<RecipientLists> {
  const { data, error } = await admin.from("message_recipients").select("address, type").eq("message_id", messageId);
  if (error) throw new Error(`recipient lookup failed: ${error.message}`);
  const out: RecipientLists = { to: [], cc: [], bcc: [] };
  for (const r of data ?? []) out[r.type].push(r.address);
  return out;
}

function bodiesFor(text: string, html: string | undefined) {
  const safeHtml = html?.trim() ? sanitizeEmailHtml(html, { allowRemoteImages: true }) : text.trim() ? textToHtml(text) : null;
  return { text: text || null, html: safeHtml, snippet: makeSnippet({ text, html: safeHtml }) };
}

// ---- drafts ---------------------------------------------------------------------------------------------------
/** Creates or updates the caller's draft. Returns the draft id. */
export async function saveDraft(ctx: InboxCtx, rawInput: DraftInput): Promise<{ draftId: string }> {
  const input = draftInputSchema.parse(rawInput);
  await requireMailboxAccess(ctx.admin, ctx.userId, input.mailboxId, "send");
  const sender = await resolveSender(ctx.admin, { id: input.mailboxId }, { requireVerified: false });
  const recipients = normalizeRecipientLists(input);
  assertContent({ subject: input.subject, text: input.text, html: input.html });
  const body = bodiesFor(input.text, input.html);

  if (input.draftId) {
    const draft = await loadOwnDraft(ctx, input.draftId);
    if (draft.mailbox_id !== input.mailboxId) throw new InboxError("invalid_request", "A draft cannot move between mailboxes", 422);
    const { error } = await ctx.admin
      .from("messages")
      .update({ subject: input.subject, text_body: body.text, html_body: body.html, snippet: body.snippet, from_address: sender.from })
      .eq("id", draft.id)
      .eq("direction", "draft")
      .eq("author_user_id", ctx.userId);
    if (error) throw new Error(`draft update failed: ${error.message}`);
    await replaceRecipients(ctx.admin, draft.workspace_id, draft.id, recipients);
    return { draftId: draft.id };
  }

  const draftId = await insertDraftMessage(ctx.admin, {
    sender,
    authorUserId: ctx.userId,
    recipients,
    subject: input.subject,
    text: body.text,
    html: body.html,
    snippet: body.snippet,
  });
  return { draftId };
}

export async function discardDraft(ctx: InboxCtx, draftId: string): Promise<void> {
  const draft = await loadOwnDraft(ctx, draftId);
  await discardDraftRow(ctx.admin, draft.id);
}

export type SendOutcome = { messageId: string; threadId: string; status: "queued" };

/** Queues a draft for sending. Idempotent per draft (double-clicks / retries are safe). */
export async function sendDraft(ctx: InboxCtx, draftId: string): Promise<SendOutcome> {
  const existing = await loadMessage(ctx, draftId, "send");
  if (existing.direction === "outbound" && existing.thread_id) {
    // Already queued by an earlier click/retry of THIS draft: report the same outcome.
    const { data: job, error } = await ctx.admin
      .from("outbox_jobs")
      .select("id")
      .eq("workspace_id", existing.workspace_id)
      .eq("idempotency_key", `ui:${existing.id}`)
      .maybeSingle();
    if (error) throw new Error(`job lookup failed: ${error.message}`);
    if (job) return { messageId: existing.id, threadId: existing.thread_id, status: "queued" };
  }
  const draft = await loadOwnDraft(ctx, draftId);
  // Re-resolve the sender NOW: mailbox/domain state may have changed since the draft was saved.
  const sender = await resolveSender(ctx.admin, { id: draft.mailbox_id });
  const recipients = normalizeRecipientLists(await loadRecipients(ctx.admin, draft.id));
  if (recipients.to.length === 0) throw new ComposeError("invalid_recipient", "At least one 'To' recipient is required", 422);
  assertContent({ subject: draft.subject, text: draft.text_body, html: draft.html_body }, { requireBody: true });

  if (draft.from_address !== sender.from) {
    await ctx.admin.from("messages").update({ from_address: sender.from }).eq("id", draft.id);
  }

  const result = await enqueueOutboundMessage(ctx.admin, {
    messageId: draft.id,
    idempotencyKey: `ui:${draft.id}`,
    recipients,
    rfcMessageId: draft.rfc_message_id ?? generateRfcMessageId(sender.rfcDomain),
    inReplyTo: draft.in_reply_to,
    references: draft.references_header,
  });
  switch (result.status) {
    case "queued":
    case "already_queued":
      return { messageId: result.messageId, threadId: result.threadId, status: "queued" };
    case "quota_exceeded":
      throw new InboxError("quota_exceeded", "Monthly sending quota exceeded", 429);
    case "workspace_inactive":
      throw new InboxError("workspace_suspended", "This workspace is suspended and cannot send email", 403);
    case "invalid":
      throw new InboxError("invalid_request", result.reason, 422);
  }
}

/** Compose + send in one step (saves the draft, then queues it). */
export async function composeAndSend(ctx: InboxCtx, input: DraftInput): Promise<SendOutcome> {
  const { draftId } = await saveDraft(ctx, input);
  return sendDraft(ctx, draftId);
}

// ---- reply -------------------------------------------------------------------------------------------------------
export function replySubject(subject: string): string {
  return looksLikeReply(subject) ? subject : `Re: ${subject}`.trim();
}

export function forwardSubject(subject: string): string {
  return /^\s*(fwd?|fw)\s*:/i.test(subject) ? subject : `Fwd: ${subject}`.trim();
}

/** Pure: who a reply goes to. Our own mailbox address is never a recipient. */
export function computeReplyRecipients(
  parent: Pick<MessageRow, "direction" | "from_address" | "reply_to">,
  parentRecipients: RecipientLists,
  ownAddress: string,
  replyAll: boolean,
): RecipientLists {
  const own = ownAddress.toLowerCase();
  const without = (list: string[]) => list.filter((a) => a !== own);
  let to: string[];
  let cc: string[] = [];
  if (parent.direction === "inbound") {
    const sender = extractAddress(parent.reply_to) ?? extractAddress(parent.from_address);
    to = sender ? [sender] : [];
    if (replyAll) cc = [...parentRecipients.to, ...parentRecipients.cc];
  } else {
    to = parentRecipients.to;
    if (replyAll) cc = parentRecipients.cc;
  }
  to = [...new Set(without(to))];
  cc = [...new Set(without(cc))].filter((a) => !to.includes(a));
  return { to, cc, bcc: [] };
}

function quoteOf(parent: MessageRow): string {
  const source = parent.text_body?.trim() ? parent.text_body : parent.html_body ? htmlToText(parent.html_body) : "";
  const quoted = source
    .slice(0, 5000)
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n");
  const when = parent.received_at ?? parent.sent_at ?? parent.created_at;
  return `\n\nOn ${when}, ${parent.from_address} wrote:\n${quoted}`;
}

export const replyInputSchema = z.object({
  messageId: uuid,
  text: z.string().max(256_000),
  html: z.string().max(512_000).optional(),
  replyAll: z.boolean().default(false),
  includeQuote: z.boolean().default(true),
  /** false = save as the caller's draft instead of sending. */
  send: z.boolean().default(true),
});

/**
 * Replies to a message in the SAME mailbox/thread with RFC 5322 threading
 * headers (In-Reply-To = parent Message-ID, References = parent chain + parent).
 */
export async function replyToMessage(
  ctx: InboxCtx,
  rawInput: z.input<typeof replyInputSchema>,
): Promise<{ draftId: string; sent: SendOutcome | null }> {
  const input = replyInputSchema.parse(rawInput);
  const parent = await loadMessage(ctx, input.messageId, "send"); // send grant on the parent's mailbox
  if (parent.direction === "draft") throw new InboxError("invalid_request", "Cannot reply to a draft", 422);
  if (!parent.thread_id) throw new InboxError("invalid_request", "Message has no thread", 422);

  const sender = await resolveSender(ctx.admin, { id: parent.mailbox_id }, { requireVerified: false });
  const parentRecipients = await loadRecipients(ctx.admin, parent.id);
  const recipients = computeReplyRecipients(parent, parentRecipients, sender.mailbox.address, input.replyAll);
  if (recipients.to.length === 0) throw new ComposeError("invalid_recipient", "No valid recipient to reply to", 422);

  const headers = buildReplyHeaders({
    rfcMessageId: parent.rfc_message_id,
    referencesHeader: parent.references_header,
    inReplyTo: parent.in_reply_to,
  });
  const text = input.includeQuote ? `${input.text}${quoteOf(parent)}` : input.text;
  const subject = replySubject(parent.subject);
  assertContent({ subject, text, html: input.html });
  const body = bodiesFor(text, input.html);

  const draftId = await insertDraftMessage(ctx.admin, {
    sender,
    authorUserId: ctx.userId,
    threadId: parent.thread_id,
    recipients: normalizeRecipientLists(recipients),
    subject,
    text: body.text,
    html: body.html,
    snippet: body.snippet,
    inReplyTo: headers.inReplyTo,
    references: headers.references,
  });
  if (!input.send) return { draftId, sent: null };
  return { draftId, sent: await sendDraft(ctx, draftId) };
}

// ---- forward ---------------------------------------------------------------------------------------------------------
export const forwardInputSchema = z.object({
  messageId: uuid,
  /** Sending mailbox; defaults to the original message's mailbox. Must be in the same workspace. */
  mailboxId: uuid.optional(),
  to: z.array(z.string().max(254)).min(1).max(50),
  cc: addrs,
  bcc: addrs,
  note: z.string().max(100_000).default(""),
  includeAttachments: z.boolean().default(true),
  send: z.boolean().default(true),
});

const MAX_FORWARD_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export async function forwardMessage(
  ctx: InboxCtx,
  rawInput: z.input<typeof forwardInputSchema>,
): Promise<{ draftId: string; sent: SendOutcome | null }> {
  const input = forwardInputSchema.parse(rawInput);
  const original = await loadMessage(ctx, input.messageId, "read"); // must be able to READ what they forward
  if (original.direction === "draft") throw new InboxError("invalid_request", "Cannot forward a draft", 422);

  const mailboxId = input.mailboxId ?? original.mailbox_id;
  const access = await requireMailboxAccess(ctx.admin, ctx.userId, mailboxId, "send");
  if (access.mailbox.workspace_id !== original.workspace_id) throw new AuthzError("Mailbox not found", 404);

  const sender = await resolveSender(ctx.admin, { id: mailboxId }, { requireVerified: false });
  const originalRecipients = await loadRecipients(ctx.admin, original.id);
  const source = original.text_body?.trim() ? original.text_body : original.html_body ? htmlToText(original.html_body) : "";
  const text = [
    input.note,
    "",
    "---------- Forwarded message ----------",
    `From: ${original.from_address}`,
    `Date: ${original.received_at ?? original.sent_at ?? original.created_at}`,
    `Subject: ${original.subject}`,
    `To: ${originalRecipients.to.join(", ")}`,
    "",
    source,
  ].join("\n");
  const subject = forwardSubject(original.subject);
  assertContent({ subject, text });
  const body = bodiesFor(text, undefined);

  // A forward starts a NEW conversation (no In-Reply-To/References, no thread yet).
  const draftId = await insertDraftMessage(ctx.admin, {
    sender,
    authorUserId: ctx.userId,
    recipients: normalizeRecipientLists(input),
    subject,
    text: body.text,
    html: body.html,
    snippet: body.snippet,
  });

  if (input.includeAttachments) {
    try {
      await copyAttachments(ctx.admin, original, draftId);
    } catch (err) {
      await discardDraftRow(ctx.admin, draftId);
      throw err;
    }
  }
  if (!input.send) return { draftId, sent: null };
  return { draftId, sent: await sendDraft(ctx, draftId) };
}

async function copyAttachments(admin: AdminClient, from: MessageRow, toMessageId: string): Promise<void> {
  const { data, error } = await admin.from("attachments").select("*").eq("message_id", from.id);
  if (error) throw new Error(`attachment lookup failed: ${error.message}`);
  const files = (data ?? []) as AttachmentRow[];
  if (files.reduce((n, a) => n + Number(a.size_bytes), 0) > MAX_FORWARD_ATTACHMENT_BYTES) {
    throw new InboxError("invalid_request", "Attachments are too large to forward", 422);
  }
  for (const a of files) {
    const dest = `${from.workspace_id}/${toMessageId}/${crypto.randomUUID()}-${a.filename.replace(/[\\/]/g, "_")}`;
    const { error: cpErr } = await admin.storage.from("attachments").copy(a.storage_path, dest);
    if (cpErr) throw new Error(`attachment copy failed: ${cpErr.message}`);
    const { error: insErr } = await admin.from("attachments").insert({
      message_id: toMessageId,
      workspace_id: from.workspace_id,
      storage_path: dest,
      filename: a.filename,
      mime_type: a.mime_type,
      size_bytes: a.size_bytes,
      content_id: a.content_id,
    });
    if (insErr) throw new Error(`attachment record failed: ${insErr.message}`);
  }
}

// ---- thread state (per user) ------------------------------------------------------------------------------------------
export const threadStateSchema = z.object({
  threadId: uuid,
  read: z.boolean().optional(),
  archived: z.boolean().optional(),
});

/** Archive/unarchive and mark read/unread. State is per-user and only needs READ access. */
export async function setThreadState(ctx: InboxCtx, rawInput: z.input<typeof threadStateSchema>): Promise<void> {
  const input = threadStateSchema.parse(rawInput);
  if (input.read === undefined && input.archived === undefined) {
    throw new InboxError("invalid_request", "Nothing to update", 422);
  }
  const { data: thread, error } = await ctx.admin
    .from("threads")
    .select("id, workspace_id, mailbox_id")
    .eq("id", input.threadId)
    .maybeSingle();
  if (error) throw new Error(`thread lookup failed: ${error.message}`);
  if (!thread) throw new AuthzError("Thread not found", 404);
  await requireMailboxAccess(ctx.admin, ctx.userId, thread.mailbox_id, "read");

  const patch: { is_read?: boolean; is_archived?: boolean } = {};
  if (input.read !== undefined) patch.is_read = input.read;
  if (input.archived !== undefined) patch.is_archived = input.archived;
  const { error: upErr } = await ctx.admin
    .from("thread_user_state")
    .upsert(
      { workspace_id: thread.workspace_id, thread_id: thread.id, user_id: ctx.userId, ...patch },
      { onConflict: "thread_id,user_id" },
    );
  if (upErr) throw new Error(`thread state update failed: ${upErr.message}`);
}

export const archiveThread = (ctx: InboxCtx, threadId: string) => setThreadState(ctx, { threadId, archived: true });
export const unarchiveThread = (ctx: InboxCtx, threadId: string) => setThreadState(ctx, { threadId, archived: false });
export const markThreadUnread = (ctx: InboxCtx, threadId: string) => setThreadState(ctx, { threadId, read: false });
export const markThreadRead = (ctx: InboxCtx, threadId: string) => setThreadState(ctx, { threadId, read: true });

// ---- attachments ---------------------------------------------------------------------------------------------------------------
export const ATTACHMENT_URL_TTL_SECONDS = 60;

/**
 * Short-lived signed URL for a private-bucket attachment, forced to download
 * (never rendered inline: attachment content is untrusted).
 */
export async function getAttachmentSignedUrl(
  ctx: InboxCtx,
  attachmentId: string,
): Promise<{ url: string; expiresInSeconds: number; filename: string }> {
  if (!uuid.safeParse(attachmentId).success) throw new AuthzError("Attachment not found", 404);
  const { data: att, error } = await ctx.admin.from("attachments").select("*").eq("id", attachmentId).maybeSingle();
  if (error) throw new Error(`attachment lookup failed: ${error.message}`);
  if (!att) throw new AuthzError("Attachment not found", 404);

  await loadMessage(ctx, att.message_id, "read"); // mailbox grant + draft privacy
  const { data: signed, error: signErr } = await ctx.admin.storage
    .from("attachments")
    .createSignedUrl(att.storage_path, ATTACHMENT_URL_TTL_SECONDS, { download: att.filename });
  if (signErr || !signed) throw new Error(`failed to sign attachment url: ${signErr?.message ?? "no data"}`);
  return { url: signed.signedUrl, expiresInSeconds: ATTACHMENT_URL_TTL_SECONDS, filename: att.filename };
}
