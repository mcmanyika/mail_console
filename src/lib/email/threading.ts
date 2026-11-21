import { nanoid } from "nanoid";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Conversation threading, JWZ-lite:
 *   1. match In-Reply-To / References against stored Message-IDs in the same mailbox;
 *   2. otherwise, only for subjects that LOOK like replies ("Re:", "Fwd:"), match a
 *      recent thread with the same normalised subject in the same mailbox;
 *   3. otherwise start a new thread.
 * Threads never span mailboxes (access control is per mailbox).
 */

const SUBJECT_PREFIX = /^\s*((re|fwd?|aw|sv|vs|antw|rv|tr)(\[\d+\])?\s*:\s*)+/i;
const MESSAGE_ID_TOKEN = /<[^<>\s]+>/g;
export const SUBJECT_FALLBACK_WINDOW_DAYS = 30;
const MAX_REFERENCES = 20;

export function normalizeSubject(subject: string | null | undefined): string {
  return (subject ?? "").replace(SUBJECT_PREFIX, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function looksLikeReply(subject: string | null | undefined): boolean {
  return SUBJECT_PREFIX.test(subject ?? "");
}

/** Canonical form: trimmed, wrapped in angle brackets. */
export function normalizeMessageId(id: string | null | undefined): string | null {
  const trimmed = id?.trim();
  if (!trimmed) return null;
  const inner = trimmed.replace(/^<|>$/g, "").trim();
  return inner && !/\s/.test(inner) ? `<${inner}>` : null;
}

/** Extracts `<id>` tokens from a References / In-Reply-To header value. */
export function parseMessageIds(header: string | null | undefined): string[] {
  if (!header) return [];
  const found = header.match(MESSAGE_ID_TOKEN) ?? [];
  return [...new Set(found)];
}

export function generateRfcMessageId(domain: string): string {
  return `<${nanoid(24)}@${domain.toLowerCase()}>`;
}

export type ThreadHeaders = {
  inReplyTo: string | null;
  references: string | null;
};

/** Headers for a reply to `parent` (RFC 5322 §3.6.4). */
export function buildReplyHeaders(parent: {
  rfcMessageId: string | null;
  referencesHeader: string | null;
  inReplyTo?: string | null;
}): ThreadHeaders {
  const parentId = normalizeMessageId(parent.rfcMessageId);
  const chain = parseMessageIds(parent.referencesHeader);
  if (chain.length === 0 && parent.inReplyTo) {
    const irt = normalizeMessageId(parent.inReplyTo);
    if (irt) chain.push(irt);
  }
  if (parentId) chain.push(parentId);
  const refs = [...new Set(chain)].slice(-MAX_REFERENCES);
  return {
    inReplyTo: parentId,
    references: refs.length ? refs.join(" ") : null,
  };
}

// ---- resolution ---------------------------------------------------------------
export interface ThreadLookup {
  /** Thread containing any message in `mailboxId` whose rfc_message_id is in `messageIds`. */
  findThreadByMessageIds(mailboxId: string, messageIds: string[]): Promise<string | null>;
  /** Most recently active thread with this normalised subject since `since`. */
  findThreadBySubject(mailboxId: string, normalizedSubject: string, since: Date): Promise<string | null>;
}

export type ThreadResolution =
  | { threadId: string; reason: "headers" | "subject" }
  | { threadId: null; reason: "new" };

export async function resolveThread(
  lookup: ThreadLookup,
  params: {
    mailboxId: string;
    subject: string;
    inReplyTo?: string | null;
    references?: string | null;
    now?: Date;
  },
): Promise<ThreadResolution> {
  const ids = [...new Set([...parseMessageIds(params.references), ...parseMessageIds(params.inReplyTo)])];
  if (ids.length) {
    const byHeader = await lookup.findThreadByMessageIds(params.mailboxId, ids);
    if (byHeader) return { threadId: byHeader, reason: "headers" };
  }

  if (looksLikeReply(params.subject)) {
    const normalized = normalizeSubject(params.subject);
    if (normalized) {
      const now = params.now ?? new Date();
      const since = new Date(now.getTime() - SUBJECT_FALLBACK_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const bySubject = await lookup.findThreadBySubject(params.mailboxId, normalized, since);
      if (bySubject) return { threadId: bySubject, reason: "subject" };
    }
  }
  return { threadId: null, reason: "new" };
}

/** Supabase-backed lookup (use with the service-role client; callers authorise first). */
export function createSupabaseThreadLookup(admin: AdminClient): ThreadLookup {
  return {
    async findThreadByMessageIds(mailboxId, messageIds) {
      const { data, error } = await admin
        .from("messages")
        .select("thread_id, created_at")
        .eq("mailbox_id", mailboxId)
        .in("rfc_message_id", messageIds)
        .not("thread_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(`thread lookup failed: ${error.message}`);
      return data?.[0]?.thread_id ?? null;
    },
    async findThreadBySubject(mailboxId, normalizedSubject, since) {
      const { data, error } = await admin
        .from("threads")
        .select("id")
        .eq("mailbox_id", mailboxId)
        .eq("normalized_subject", normalizedSubject)
        .gte("last_activity_at", since.toISOString())
        .order("last_activity_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(`thread lookup failed: ${error.message}`);
      return data?.[0]?.id ?? null;
    },
  };
}

/** Finds the thread for an inbound message or creates one. Returns the thread id. */
export async function findOrCreateThread(
  admin: AdminClient,
  params: {
    workspaceId: string;
    mailboxId: string;
    subject: string;
    inReplyTo?: string | null;
    references?: string | null;
    /**
     * Allow the "Re: <subject>" heuristic. Inbound mail passes `false`: a
     * sender-controlled subject must not be able to join an existing
     * conversation (only In-Reply-To/References inside the mailbox can).
     */
    subjectFallback?: boolean;
  },
): Promise<string> {
  const lookup = createSupabaseThreadLookup(admin);
  const resolution = await resolveThread(
    params.subjectFallback === false ? { ...lookup, findThreadBySubject: async () => null } : lookup,
    params,
  );
  if (resolution.threadId) return resolution.threadId;

  const { data, error } = await admin
    .from("threads")
    .insert({
      workspace_id: params.workspaceId,
      mailbox_id: params.mailboxId,
      subject: params.subject,
      normalized_subject: normalizeSubject(params.subject),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`failed to create thread: ${error?.message ?? "no data"}`);
  return data.id;
}
