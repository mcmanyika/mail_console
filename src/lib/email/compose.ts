import type { AdminClient } from "@/lib/supabase/admin";
import type { DomainRow, MailboxRow } from "@/lib/types/database";
import { MAX_RECIPIENTS_PER_MESSAGE } from "./quota";
import { formatFromHeader, hasControlChars, isValidEmailAddress, normalizeAddress } from "./address";

/**
 * Shared building blocks for creating outbound messages, used by BOTH the
 * transactional API (integration keys) and inbox server actions (users).
 *
 * Rule: the `From` header is ALWAYS resolved here, server-side, from an
 * approved mailbox row. No caller can supply a raw From.
 */

export const COMPOSE_LIMITS = {
  subjectChars: 998,
  textBytes: 256_000,
  htmlBytes: 512_000,
} as const;

export class ComposeError extends Error {
  constructor(
    readonly code:
      | "mailbox_not_found"
      | "mailbox_disabled"
      | "sender_not_verified"
      | "invalid_recipient"
      | "too_many_recipients"
      | "invalid_content"
      | "internal",
    message: string,
    readonly status: 400 | 403 | 404 | 422 | 500 = 422,
  ) {
    super(message);
    this.name = "ComposeError";
  }
}

export type SenderInfo = {
  mailbox: MailboxRow;
  domain: DomainRow;
  /** Full `From` header value, e.g. `"Support" <support@mail.example.com>`. */
  from: string;
  /** Domain used for generated Message-IDs. */
  rfcDomain: string;
};

/** Loads an approved sender (mailbox + verified sending domain). Throws ComposeError otherwise. */
export async function resolveSender(
  admin: AdminClient,
  mailboxRef: { id: string } | { address: string },
  scope: { workspaceId?: string; /** Drafts may be saved before the domain verifies; sending may not. Default true. */ requireVerified?: boolean } = {},
): Promise<SenderInfo> {
  let q = admin.from("mailboxes").select("*");
  q = "id" in mailboxRef ? q.eq("id", mailboxRef.id) : q.eq("address", normalizeAddress(mailboxRef.address));
  if (scope.workspaceId) q = q.eq("workspace_id", scope.workspaceId);
  const { data: mailbox, error } = await q.maybeSingle();
  if (error) throw new ComposeError("internal", "Mailbox lookup failed", 500);
  if (!mailbox) throw new ComposeError("mailbox_not_found", "Mailbox not found", 404);
  if (!mailbox.enabled) throw new ComposeError("mailbox_disabled", "This mailbox is disabled", 403);

  const { data: domain, error: dErr } = await admin
    .from("domains")
    .select("*")
    .eq("id", mailbox.domain_id)
    .eq("workspace_id", mailbox.workspace_id)
    .maybeSingle();
  if (dErr) throw new ComposeError("internal", "Domain lookup failed", 500);
  if (!domain) throw new ComposeError("mailbox_not_found", "Mailbox not found", 404);
  if (scope.requireVerified !== false && domain.send_status !== "verified") {
    throw new ComposeError("sender_not_verified", `Sending domain ${domain.hostname} is not verified yet`, 422);
  }
  return { mailbox, domain, from: formatFromHeader(mailbox.display_name, mailbox.address), rfcDomain: domain.hostname };
}

export type RecipientLists = { to: string[]; cc: string[]; bcc: string[] };

/** Validates, lower-cases and de-duplicates recipients (precedence to > cc > bcc). */
export function normalizeRecipientLists(input: { to?: readonly string[]; cc?: readonly string[]; bcc?: readonly string[] }): RecipientLists {
  const seen = new Set<string>();
  const out: RecipientLists = { to: [], cc: [], bcc: [] };
  for (const type of ["to", "cc", "bcc"] as const) {
    for (const raw of input[type] ?? []) {
      const address = normalizeAddress(raw);
      if (hasControlChars(raw) || !isValidEmailAddress(address)) {
        throw new ComposeError("invalid_recipient", `Invalid ${type} address`, 422);
      }
      if (seen.has(address)) continue;
      seen.add(address);
      out[type].push(address);
    }
  }
  if (out.to.length + out.cc.length + out.bcc.length > MAX_RECIPIENTS_PER_MESSAGE) {
    throw new ComposeError("too_many_recipients", `At most ${MAX_RECIPIENTS_PER_MESSAGE} recipients per message`, 422);
  }
  return out;
}

export function assertContent(c: { subject: string; text?: string | null; html?: string | null }, opts: { requireBody?: boolean } = {}) {
  if (hasControlChars(c.subject)) throw new ComposeError("invalid_content", "Subject may not contain control characters", 422);
  if (c.subject.length > COMPOSE_LIMITS.subjectChars) throw new ComposeError("invalid_content", "Subject is too long", 422);
  if (c.text && Buffer.byteLength(c.text, "utf8") > COMPOSE_LIMITS.textBytes) throw new ComposeError("invalid_content", "Text body is too large", 422);
  if (c.html && Buffer.byteLength(c.html, "utf8") > COMPOSE_LIMITS.htmlBytes) throw new ComposeError("invalid_content", "HTML body is too large", 422);
  if (opts.requireBody && !c.text?.trim() && !c.html?.trim()) throw new ComposeError("invalid_content", "A text or html body is required", 422);
}

export async function insertRecipients(admin: AdminClient, workspaceId: string, messageId: string, r: RecipientLists) {
  const rows = (["to", "cc", "bcc"] as const).flatMap((type) =>
    r[type].map((address) => ({ message_id: messageId, workspace_id: workspaceId, address, type })),
  );
  if (rows.length === 0) return;
  const { error } = await admin
    .from("message_recipients")
    .upsert(rows, { onConflict: "message_id,address,type", ignoreDuplicates: true });
  if (error) throw new ComposeError("internal", "Failed to save recipients", 500);
}

/** Replaces all recipients of a (draft) message. */
export async function replaceRecipients(admin: AdminClient, workspaceId: string, messageId: string, r: RecipientLists) {
  const { error } = await admin.from("message_recipients").delete().eq("message_id", messageId);
  if (error) throw new ComposeError("internal", "Failed to save recipients", 500);
  await insertRecipients(admin, workspaceId, messageId, r);
}

export type DraftParams = {
  sender: SenderInfo;
  /** Exactly one of these identifies the creator. */
  authorUserId?: string;
  integrationId?: string;
  threadId?: string | null;
  recipients: RecipientLists;
  subject: string;
  text?: string | null;
  html?: string | null;
  replyTo?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  snippet?: string | null;
};

/** Inserts a `draft` message + recipients. Returns the new message id. */
export async function insertDraftMessage(admin: AdminClient, p: DraftParams): Promise<string> {
  const { data, error } = await admin
    .from("messages")
    .insert({
      workspace_id: p.sender.mailbox.workspace_id,
      thread_id: p.threadId ?? null,
      mailbox_id: p.sender.mailbox.id,
      direction: "draft",
      lifecycle_state: "draft",
      from_address: p.sender.from, // server-resolved
      reply_to: p.replyTo ?? null,
      subject: p.subject,
      snippet: p.snippet ?? null,
      text_body: p.text ?? null,
      html_body: p.html ?? null,
      in_reply_to: p.inReplyTo ?? null,
      references_header: p.references ?? null,
      author_user_id: p.authorUserId ?? null,
      created_by_integration_id: p.integrationId ?? null,
    })
    .select("id")
    .single();
  if (error || !data) throw new ComposeError("internal", "Failed to create message", 500);
  try {
    await insertRecipients(admin, p.sender.mailbox.workspace_id, data.id, p.recipients);
  } catch (err) {
    await admin.from("messages").delete().eq("id", data.id);
    throw err;
  }
  return data.id;
}

/** Deletes a message that never made it out of draft state (used to unwind failed enqueues). */
export async function discardDraftRow(admin: AdminClient, messageId: string): Promise<void> {
  await admin.from("messages").delete().eq("id", messageId).eq("direction", "draft");
}
