import { createHash, randomUUID } from "node:crypto";
import { getMaxAttachmentBytes } from "@/lib/env";
import type { EmailAdapter } from "@/lib/resend/adapter";
import type { DownloadedAttachment, ProviderWebhookEvent, ReceivedAttachmentMeta, ReceivedEmail } from "@/lib/resend/types";
import type { AdminClient } from "@/lib/supabase/admin";
import { extractAddress, extractAddresses, hasControlChars, stripPlusTag } from "./address";
import { makeSnippet, sanitizeEmailHtml } from "./sanitize";
import {
  createSupabaseThreadLookup,
  normalizeMessageId,
  normalizeSubject,
  resolveThread,
} from "./threading";

/**
 * Inbound pipeline for `email.received`.
 *
 * Security model:
 *  - The webhook is signature-verified, so the EVENT payload is provider
 *    authored. Mailbox routing uses ONLY provider-supplied recipient fields
 *    (`received_for`, or `to`/`cc`/`bcc` of the event and of the provider's
 *    parsed email). Message HEADERS (Delivered-To, X-Original-To, X-Workspace,
 *    Reply-To, From …) are sender-controlled and are never used to pick a
 *    mailbox/workspace.
 *  - Bodies, subjects, filenames and attachments are untrusted: HTML is
 *    sanitised before storage (scripts stripped, remote images blocked, only
 *    safe URL schemes), text is stored as text, attachment bytes go to the
 *    PRIVATE bucket and are only ever served via short-lived signed URLs.
 *  - One provider email can match several mailboxes (even in different
 *    workspaces). Each match gets its OWN thread/message/attachment records,
 *    scoped to that mailbox's workspace; nothing is shared between them.
 */

export const INBOUND_LIMITS = {
  textBytes: 1_000_000,
  htmlBytes: 2_000_000,
  subjectChars: 998,
  recipientsStored: 100,
  attachmentsPerEmail: 25,
} as const;

export type InboundStoredMessage = {
  mailboxId: string;
  workspaceId: string;
  messageId: string;
  threadId: string;
  created: boolean;
  attachmentsStored: number;
};

export type InboundResult =
  | { outcome: "stored"; messages: InboundStoredMessage[]; warnings: string[] }
  | { outcome: "unmatched"; reason: "no_known_recipient" | "malformed_event" };

export type InboundOptions = {
  /**
   * Demo/fixtures only: when the mock provider has no stored copy of the email,
   * build it from `text` / `html` / `headers` fields embedded in the event data.
   */
  allowInlineContent?: boolean;
};

type MailboxMatch = { id: string; workspace_id: string; address: string };

// ---- helpers (exported for tests) -----------------------------------------------------
function asStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

/**
 * Trusted recipient candidates from a provider-authored object. `received_for`
 * (the actual delivery target, when the provider supplies it) wins exclusively.
 */
export function trustedRecipients(source: {
  received_for?: unknown;
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
}): string[] {
  const receivedFor = extractAddresses(asStringArray(source.received_for));
  if (receivedFor.length) return receivedFor;
  return extractAddresses([...asStringArray(source.to), ...asStringArray(source.cc), ...asStringArray(source.bcc)]);
}

export function safeFilename(name: string | null | undefined): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f"<>:|?*]/g, "_")
    .replace(/^\.+/, "_")
    .trim()
    .slice(0, 120);
  return cleaned || "attachment";
}

export function safeMimeType(type: string | null | undefined): string {
  const t = (type ?? "").split(";")[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(t) ? t : "application/octet-stream";
}

/** Stable uuid-shaped id from a seed so retried attachment uploads overwrite the same object. */
export function deterministicUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function cleanHeaderText(value: string | null | undefined, max: number): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function truncateBytes(value: string | null | undefined, maxBytes: number): string | null {
  if (value == null) return null;
  return Buffer.byteLength(value, "utf8") <= maxBytes ? value : Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
}

function inlineEmailFromEvent(event: ProviderWebhookEvent, providerEmailId: string): ReceivedEmail {
  const d = event.data;
  const headers: Record<string, string> = {};
  if (d.headers && typeof d.headers === "object") {
    for (const [k, v] of Object.entries(d.headers as Record<string, unknown>)) headers[k.toLowerCase()] = String(v);
  }
  return {
    providerEmailId,
    from: typeof d.from === "string" ? d.from : "",
    to: asStringArray(d.to),
    cc: asStringArray(d.cc),
    bcc: asStringArray(d.bcc),
    replyTo: asStringArray(d.reply_to),
    subject: typeof d.subject === "string" ? d.subject : "",
    text: typeof d.text === "string" ? d.text : null,
    html: typeof d.html === "string" ? d.html : null,
    headers,
    messageId: typeof d.message_id === "string" ? d.message_id : (headers["message-id"] ?? null),
    receivedAt: typeof d.created_at === "string" ? d.created_at : event.createdAt,
    attachments: [],
  };
}

// ---- mailbox routing ------------------------------------------------------------------
export async function findActiveMailboxes(admin: AdminClient, candidates: string[]): Promise<MailboxMatch[]> {
  if (candidates.length === 0) return [];
  // Exact address first; plus-addressing (`support+x@`) falls back to the base mailbox.
  const lookups = [...new Set(candidates.flatMap((c) => [c, stripPlusTag(c)]))];
  const { data, error } = await admin
    .from("mailboxes")
    .select("id, workspace_id, address")
    .in("address", lookups)
    .eq("enabled", true);
  if (error) throw new Error(`mailbox lookup failed: ${error.message}`);
  const byId = new Map<string, MailboxMatch>();
  for (const m of data ?? []) byId.set(m.id, m);
  return [...byId.values()];
}

// ---- main ------------------------------------------------------------------------------
export async function processInboundEmailEvent(
  admin: AdminClient,
  adapter: EmailAdapter,
  event: ProviderWebhookEvent,
  options: InboundOptions = {},
): Promise<InboundResult> {
  const providerEmailId = typeof event.data.email_id === "string" ? event.data.email_id : null;
  if (!providerEmailId) return { outcome: "unmatched", reason: "malformed_event" };

  // Cheap pre-check from the event itself: don't download content for mail nobody owns.
  const eventCandidates = trustedRecipients(event.data);
  let mailboxes = await findActiveMailboxes(admin, eventCandidates);
  if (mailboxes.length === 0 && eventCandidates.length > 0) {
    return { outcome: "unmatched", reason: "no_known_recipient" };
  }

  let email: ReceivedEmail;
  try {
    email = await adapter.getReceivedEmail(providerEmailId);
  } catch (err) {
    if (options.allowInlineContent && adapter.mode === "mock") email = inlineEmailFromEvent(event, providerEmailId);
    else throw err;
  }

  // Merge in the provider-parsed recipients (still provider-authored, not raw headers),
  // unless the provider told us the exact delivery target via `received_for`.
  const exclusive = extractAddresses(asStringArray(event.data.received_for)).length > 0;
  const fetchedCandidates = exclusive ? [] : trustedRecipients({ to: email.to, cc: email.cc, bcc: email.bcc });
  mailboxes = await findActiveMailboxes(admin, [...new Set([...eventCandidates, ...fetchedCandidates])]);
  if (mailboxes.length === 0) return { outcome: "unmatched", reason: "no_known_recipient" };

  const warnings: string[] = [];
  const attachmentCache = new Map<string, DownloadedAttachment>();
  const messages: InboundStoredMessage[] = [];
  for (const mailbox of mailboxes) {
    messages.push(await storeForMailbox(admin, adapter, mailbox, email, attachmentCache, warnings));
  }
  return { outcome: "stored", messages, warnings };
}

async function storeForMailbox(
  admin: AdminClient,
  adapter: EmailAdapter,
  mailbox: MailboxMatch,
  email: ReceivedEmail,
  attachmentCache: Map<string, DownloadedAttachment>,
  warnings: string[],
): Promise<InboundStoredMessage> {
  const headers = email.headers;
  const subject = cleanHeaderText(email.subject, INBOUND_LIMITS.subjectChars);
  const inReplyTo = cleanHeaderText(headers["in-reply-to"], 998) || null;
  const references = cleanHeaderText(headers["references"], 4000) || null;

  // Idempotent per (mailbox, provider email): a retry after partial progress reuses the row.
  const findExisting = async () => {
    const { data, error } = await admin
      .from("messages")
      .select("id, thread_id")
      .eq("mailbox_id", mailbox.id)
      .eq("resend_email_id", email.providerEmailId)
      .eq("direction", "inbound")
      .maybeSingle();
    if (error) throw new Error(`inbound lookup failed: ${error.message}`);
    return data;
  };

  let existing = await findExisting();
  let created = false;
  let messageId: string;
  let threadId: string;

  if (existing?.thread_id) {
    messageId = existing.id;
    threadId = existing.thread_id;
  } else {
    // Thread strictly by In-Reply-To/References inside THIS mailbox; else a new thread.
    // (No subject heuristic: the subject is sender-controlled.)
    const resolution = await resolveThread(
      { ...createSupabaseThreadLookup(admin), findThreadBySubject: async () => null },
      { mailboxId: mailbox.id, subject, inReplyTo, references },
    );
    let createdThreadId: string | null = null;
    if (resolution.threadId) threadId = resolution.threadId;
    else {
      const { data: t, error: tErr } = await admin
        .from("threads")
        .insert({
          workspace_id: mailbox.workspace_id,
          mailbox_id: mailbox.id,
          subject,
          normalized_subject: normalizeSubject(subject),
        })
        .select("id")
        .single();
      if (tErr || !t) throw new Error(`failed to create thread: ${tErr?.message ?? "no data"}`);
      threadId = createdThreadId = t.id;
    }

    const html = email.html ? truncateBytes(email.html, INBOUND_LIMITS.htmlBytes) : null;
    const text = truncateBytes(email.text, INBOUND_LIMITS.textBytes);
    const sanitizedHtml = html ? sanitizeEmailHtml(html, { allowRemoteImages: false }) : null;
    const receivedAt = Number.isNaN(Date.parse(email.receivedAt)) ? new Date().toISOString() : new Date(email.receivedAt).toISOString();
    const replyTo = extractAddress(email.replyTo[0]);

    messageId = randomUUID();
    const { error: mErr } = await admin.from("messages").insert({
      id: messageId,
      workspace_id: mailbox.workspace_id,
      thread_id: threadId,
      mailbox_id: mailbox.id,
      direction: "inbound",
      lifecycle_state: "received",
      from_address: cleanHeaderText(email.from, 998),
      reply_to: replyTo,
      subject,
      snippet: makeSnippet({ text, html: sanitizedHtml }),
      text_body: text,
      html_body: sanitizedHtml,
      resend_email_id: email.providerEmailId,
      rfc_message_id: normalizeMessageId(email.messageId ?? headers["message-id"]),
      in_reply_to: inReplyTo,
      references_header: references,
      received_at: receivedAt,
    });
    if (mErr) {
      if (createdThreadId) await admin.from("threads").delete().eq("id", createdThreadId);
      if (mErr.code === "23505") {
        // Lost a race with a concurrent delivery of the same event: use the winner's row.
        existing = await findExisting();
        if (!existing?.thread_id) throw new Error(`inbound insert conflict but no row found: ${mErr.message}`);
        messageId = existing.id;
        threadId = existing.thread_id;
      } else {
        throw new Error(`failed to store inbound message: ${mErr.message}`);
      }
    } else {
      created = true;
      await storeInboundRecipients(admin, mailbox.workspace_id, messageId, email);
      // New mail resurfaces the conversation for everyone who archived it.
      await admin
        .from("thread_user_state")
        .update({ is_read: false, is_archived: false })
        .eq("thread_id", threadId);
    }
  }

  const attachmentsStored = await storeAttachments(admin, adapter, mailbox, messageId, email, attachmentCache, warnings);
  return { mailboxId: mailbox.id, workspaceId: mailbox.workspace_id, messageId, threadId, created, attachmentsStored };
}

async function storeInboundRecipients(admin: AdminClient, workspaceId: string, messageId: string, email: ReceivedEmail) {
  const rows: { message_id: string; workspace_id: string; address: string; type: "to" | "cc"; delivery_state: "received" }[] = [];
  const seen = new Set<string>();
  for (const [type, list] of [["to", email.to], ["cc", email.cc]] as const) {
    for (const address of extractAddresses(list)) {
      if (seen.has(address)) continue;
      seen.add(address);
      rows.push({ message_id: messageId, workspace_id: workspaceId, address, type, delivery_state: "received" });
    }
  }
  if (rows.length === 0) return;
  const { error } = await admin
    .from("message_recipients")
    .upsert(rows.slice(0, INBOUND_LIMITS.recipientsStored), { onConflict: "message_id,address,type", ignoreDuplicates: true });
  if (error) throw new Error(`failed to store recipients: ${error.message}`);
}

async function storeAttachments(
  admin: AdminClient,
  adapter: EmailAdapter,
  mailbox: MailboxMatch,
  messageId: string,
  email: ReceivedEmail,
  cache: Map<string, DownloadedAttachment>,
  warnings: string[],
): Promise<number> {
  const metas = email.attachments.slice(0, INBOUND_LIMITS.attachmentsPerEmail);
  if (email.attachments.length > metas.length) warnings.push(`attachments truncated to ${metas.length}`);
  if (metas.length === 0) return 0;

  const { data: existing, error: exErr } = await admin
    .from("attachments")
    .select("provider_attachment_id")
    .eq("message_id", messageId);
  if (exErr) throw new Error(`attachment lookup failed: ${exErr.message}`);
  const have = new Set((existing ?? []).map((a) => a.provider_attachment_id));

  const maxBytes = getMaxAttachmentBytes();
  let stored = 0;
  for (const meta of metas) {
    if (have.has(meta.providerAttachmentId)) continue;
    if (meta.size > maxBytes) {
      warnings.push(`attachment ${meta.providerAttachmentId} skipped: exceeds ${maxBytes} bytes`);
      continue;
    }
    const file = await downloadOnce(adapter, email.providerEmailId, meta, cache);
    if (file.data.byteLength > maxBytes) {
      warnings.push(`attachment ${meta.providerAttachmentId} skipped: exceeds ${maxBytes} bytes`);
      continue;
    }
    const filename = safeFilename(meta.filename ?? file.filename);
    const mime = safeMimeType(meta.contentType || file.contentType);
    const objectId = deterministicUuid(`${messageId}:${meta.providerAttachmentId}`);
    // Convention (see 00002_storage.sql): <workspace_id>/<message_id>/<uuid>-<filename>
    const storagePath = `${mailbox.workspace_id}/${messageId}/${objectId}-${filename}`;

    const { error: upErr } = await admin.storage
      .from("attachments")
      .upload(storagePath, file.data, { contentType: mime, upsert: true });
    if (upErr) throw new Error(`attachment upload failed: ${upErr.message}`);

    const { error: insErr } = await admin.from("attachments").insert({
      message_id: messageId,
      workspace_id: mailbox.workspace_id,
      storage_path: storagePath,
      filename,
      mime_type: mime,
      size_bytes: file.data.byteLength,
      content_id: meta.contentId && !hasControlChars(meta.contentId) ? meta.contentId.replace(/^<|>$/g, "").slice(0, 255) : null,
      provider_attachment_id: meta.providerAttachmentId,
    });
    if (insErr && insErr.code !== "23505") throw new Error(`failed to record attachment: ${insErr.message}`);
    stored++;
  }
  return stored;
}

async function downloadOnce(
  adapter: EmailAdapter,
  providerEmailId: string,
  meta: ReceivedAttachmentMeta,
  cache: Map<string, DownloadedAttachment>,
): Promise<DownloadedAttachment> {
  const hit = cache.get(meta.providerAttachmentId);
  if (hit) return hit;
  const file = await adapter.downloadReceivedAttachment(providerEmailId, meta.providerAttachmentId);
  cache.set(meta.providerAttachmentId, file);
  return file;
}
