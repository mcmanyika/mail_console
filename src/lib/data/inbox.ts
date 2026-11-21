import { cache } from "react";
import { requireMailboxAccess } from "@/lib/auth/authz";
import { sanitizeSearch } from "@/lib/format";
import type {
  AttachmentRow,
  DeliveryState,
  MailboxPermission,
  MessageLifecycleState,
  MessageRecipientRow,
  MessageRow,
  ThreadRow,
} from "@/lib/types/database";
import { getReadableMailboxes, getWorkspaceContext } from "./workspace";

export type Folder = "inbox" | "sent" | "drafts" | "archive";
export const FOLDERS: Folder[] = ["inbox", "sent", "drafts", "archive"];
export function parseFolder(v: string | undefined): Folder {
  return (FOLDERS as string[]).includes(v ?? "") ? (v as Folder) : "inbox";
}

const LIST_LIMIT = 100;
const THREAD_FETCH_LIMIT = 400;

export type ListItem = {
  /** Thread id (inbox/archive/sent) or draft message id (drafts). */
  key: string;
  threadId: string | null;
  draftId?: string;
  mailboxId: string;
  subject: string;
  snippet: string;
  /** "From" for inbound, "To" for outbound/drafts (already prefixed in `party`). */
  party: string;
  at: string;
  unread: boolean;
  messageCount: number;
  state?: MessageLifecycleState;
  failureReason?: string | null;
};

type Summary = {
  threadId: string;
  mailboxId: string;
  subject: string;
  lastActivityAt: string;
  isRead: boolean;
  isArchived: boolean;
  hasInbound: boolean;
  messageCount: number;
  latest: { direction: string; from: string; snippet: string; at: string; state: MessageLifecycleState } | null;
};

/**
 * Per-thread summaries for the signed-in user across the given mailboxes.
 * Reads via the user's RLS client: only explicitly-granted mailboxes ever
 * return rows. Memoised per request on (slug, ids, thread filter).
 */
const loadSummaries = cache(async (slug: string, mailboxKey: string, threadFilterKey: string): Promise<Summary[]> => {
  const mailboxIds = mailboxKey ? mailboxKey.split(",") : [];
  if (mailboxIds.length === 0) return [];
  const { supabase, user } = await getWorkspaceContext(slug);

  let tq = supabase
    .from("threads")
    .select("id, mailbox_id, subject, last_activity_at")
    .in("mailbox_id", mailboxIds)
    .order("last_activity_at", { ascending: false })
    .limit(THREAD_FETCH_LIMIT);
  if (threadFilterKey) tq = tq.in("id", threadFilterKey.split(","));
  const { data: threads, error } = await tq;
  if (error) throw new Error(`failed to load threads: ${error.message}`);
  if (!threads?.length) return [];
  const ids = threads.map((t) => t.id);

  const [{ data: states, error: sErr }, { data: messages, error: mErr }] = await Promise.all([
    supabase.from("thread_user_state").select("thread_id, is_read, is_archived").eq("user_id", user.id).in("thread_id", ids),
    supabase
      .from("messages")
      .select("thread_id, direction, from_address, snippet, created_at, received_at, sent_at, lifecycle_state")
      .in("thread_id", ids)
      .neq("direction", "draft")
      .order("created_at", { ascending: false })
      .limit(3000),
  ]);
  if (sErr) throw new Error(`failed to load thread state: ${sErr.message}`);
  if (mErr) throw new Error(`failed to load messages: ${mErr.message}`);

  const stateBy = new Map((states ?? []).map((s) => [s.thread_id, s]));
  const msgBy = new Map<string, NonNullable<typeof messages>>();
  for (const m of messages ?? []) {
    if (!m.thread_id) continue;
    const list = msgBy.get(m.thread_id) ?? [];
    list.push(m);
    msgBy.set(m.thread_id, list);
  }

  return (threads as Pick<ThreadRow, "id" | "mailbox_id" | "subject" | "last_activity_at">[]).map((t) => {
    const msgs = msgBy.get(t.id) ?? [];
    const latest = msgs[0];
    const st = stateBy.get(t.id);
    return {
      threadId: t.id,
      mailboxId: t.mailbox_id,
      subject: t.subject,
      lastActivityAt: t.last_activity_at,
      isRead: st?.is_read ?? false,
      isArchived: st?.is_archived ?? false,
      hasInbound: msgs.some((m) => m.direction === "inbound"),
      messageCount: msgs.length,
      latest: latest
        ? {
            direction: latest.direction,
            from: latest.from_address,
            snippet: latest.snippet ?? "",
            at: latest.received_at ?? latest.sent_at ?? latest.created_at,
            state: latest.lifecycle_state,
          }
        : null,
    };
  });
});

function isUnread(s: Summary): boolean {
  return s.hasInbound && !s.isRead && !s.isArchived;
}

/** Unread inbox threads: total + per mailbox (not affected by search/filters). */
export async function getUnreadCounts(slug: string): Promise<{ total: number; byMailbox: Record<string, number> }> {
  const mailboxes = await getReadableMailboxes(slug);
  const all = await loadSummaries(slug, mailboxes.map((m) => m.id).sort().join(","), "");
  const byMailbox: Record<string, number> = {};
  let total = 0;
  for (const s of all) {
    if (!isUnread(s)) continue;
    total += 1;
    byMailbox[s.mailboxId] = (byMailbox[s.mailboxId] ?? 0) + 1;
  }
  return { total, byMailbox };
}

export async function getDraftCount(slug: string): Promise<number> {
  const mailboxes = await getReadableMailboxes(slug);
  if (mailboxes.length === 0) return 0;
  const { supabase, user } = await getWorkspaceContext(slug);
  const { count } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("direction", "draft")
    .eq("author_user_id", user.id)
    .in("mailbox_id", mailboxes.map((m) => m.id));
  return count ?? 0;
}

export async function listFolder(
  slug: string,
  opts: { folder: Folder; mailboxId: string | null; q: string },
): Promise<{ items: ListItem[]; truncated: boolean }> {
  const readable = await getReadableMailboxes(slug);
  const allIds = readable.map((m) => m.id).sort();
  const scoped = opts.mailboxId ? allIds.filter((id) => id === opts.mailboxId) : allIds;
  if (scoped.length === 0) return { items: [], truncated: false };
  const { supabase, user } = await getWorkspaceContext(slug);
  const q = sanitizeSearch(opts.q);

  if (opts.folder === "drafts") {
    let dq = supabase
      .from("messages")
      .select("id, thread_id, mailbox_id, subject, snippet, created_at, updated_at")
      .eq("direction", "draft")
      .eq("author_user_id", user.id)
      .in("mailbox_id", scoped)
      .order("updated_at", { ascending: false })
      .limit(LIST_LIMIT);
    if (q) dq = dq.or(`subject.ilike.%${q}%,snippet.ilike.%${q}%`);
    const { data, error } = await dq;
    if (error) throw new Error(`failed to load drafts: ${error.message}`);
    const rcpts = await recipientsByMessage(supabase, (data ?? []).map((d) => d.id));
    return {
      truncated: (data?.length ?? 0) >= LIST_LIMIT,
      items: (data ?? []).map((d) => ({
        key: d.id,
        threadId: d.thread_id,
        draftId: d.id,
        mailboxId: d.mailbox_id,
        subject: d.subject || "(no subject)",
        snippet: d.snippet ?? "",
        party: `To: ${(rcpts.get(d.id) ?? []).filter((r) => r.type === "to").map((r) => r.address).join(", ") || "no recipients"}`,
        at: d.updated_at,
        unread: false,
        messageCount: 1,
        state: "draft",
      })),
    };
  }

  if (opts.folder === "sent") {
    let sq = supabase
      .from("messages")
      .select("id, thread_id, mailbox_id, subject, snippet, created_at, sent_at, lifecycle_state, failure_reason")
      .eq("direction", "outbound")
      .in("mailbox_id", scoped)
      .order("created_at", { ascending: false })
      .limit(LIST_LIMIT);
    if (q) sq = sq.or(`subject.ilike.%${q}%,snippet.ilike.%${q}%,text_body.ilike.%${q}%`);
    const { data, error } = await sq;
    if (error) throw new Error(`failed to load sent mail: ${error.message}`);
    const rcpts = await recipientsByMessage(supabase, (data ?? []).map((d) => d.id));
    return {
      truncated: (data?.length ?? 0) >= LIST_LIMIT,
      items: (data ?? []).map((d) => ({
        key: d.id,
        threadId: d.thread_id,
        mailboxId: d.mailbox_id,
        subject: d.subject || "(no subject)",
        snippet: d.snippet ?? "",
        party: `To: ${(rcpts.get(d.id) ?? []).filter((r) => r.type === "to").map((r) => r.address).join(", ")}`,
        at: d.sent_at ?? d.created_at,
        unread: false,
        messageCount: 1,
        state: d.lifecycle_state,
        failureReason: d.failure_reason,
      })),
    };
  }

  // inbox / archive: thread-level
  let filterKey = "";
  if (q) {
    const { data: hits, error } = await supabase
      .from("messages")
      .select("thread_id")
      .in("mailbox_id", scoped)
      .neq("direction", "draft")
      .not("thread_id", "is", null)
      .or(`subject.ilike.%${q}%,snippet.ilike.%${q}%,from_address.ilike.%${q}%,text_body.ilike.%${q}%`)
      .limit(500);
    if (error) throw new Error(`search failed: ${error.message}`);
    const ids = [...new Set((hits ?? []).map((h) => h.thread_id as string))];
    if (ids.length === 0) return { items: [], truncated: false };
    filterKey = ids.sort().join(",");
  }
  const summaries = await loadSummaries(slug, scoped.join(","), filterKey);
  const wantArchived = opts.folder === "archive";
  const filtered = summaries
    .filter((s) => (wantArchived ? s.isArchived : !s.isArchived && s.hasInbound))
    .slice(0, LIST_LIMIT);
  return {
    truncated: summaries.length >= THREAD_FETCH_LIMIT,
    items: filtered.map((s) => ({
      key: s.threadId,
      threadId: s.threadId,
      mailboxId: s.mailboxId,
      subject: s.subject || "(no subject)",
      snippet: s.latest?.snippet ?? "",
      party: s.latest ? (s.latest.direction === "outbound" ? "You" : s.latest.from) : "",
      at: s.latest?.at ?? s.lastActivityAt,
      unread: isUnread(s),
      messageCount: s.messageCount,
    })),
  };
}

async function recipientsByMessage(
  supabase: Awaited<ReturnType<typeof getWorkspaceContext>>["supabase"],
  ids: string[],
): Promise<Map<string, Pick<MessageRecipientRow, "address" | "type">[]>> {
  const map = new Map<string, Pick<MessageRecipientRow, "address" | "type">[]>();
  if (!ids.length) return map;
  const { data } = await supabase.from("message_recipients").select("message_id, address, type").in("message_id", ids);
  for (const r of data ?? []) {
    const list = map.get(r.message_id) ?? [];
    list.push(r);
    map.set(r.message_id, list);
  }
  return map;
}

// ---- thread detail ------------------------------------------------------------------
export type ThreadMessage = Pick<
  MessageRow,
  | "id"
  | "direction"
  | "lifecycle_state"
  | "from_address"
  | "reply_to"
  | "subject"
  | "text_body"
  | "html_body"
  | "failure_reason"
  | "created_at"
  | "sent_at"
  | "received_at"
  | "author_user_id"
  | "mailbox_id"
> & {
  recipients: Pick<MessageRecipientRow, "address" | "type" | "delivery_state">[];
  attachments: Pick<AttachmentRow, "id" | "filename" | "mime_type" | "size_bytes" | "content_id">[];
  authorName: string | null;
};

export type ThreadDetail = {
  thread: Pick<ThreadRow, "id" | "subject" | "mailbox_id">;
  mailboxAddress: string;
  permission: MailboxPermission;
  canSend: boolean;
  isRead: boolean;
  isArchived: boolean;
  messages: ThreadMessage[];
};

export type ThreadResult =
  | { status: "ok"; detail: ThreadDetail }
  | { status: "not_found" }
  | { status: "denied" };

export async function getThread(slug: string, threadId: string): Promise<ThreadResult> {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) return { status: "not_found" };
  const ctx = await getWorkspaceContext(slug);
  const { supabase, user } = ctx;
  const { data: thread, error } = await supabase
    .from("threads")
    .select("id, subject, mailbox_id, workspace_id")
    .eq("id", threadId)
    .maybeSingle();
  if (error) throw new Error(`thread lookup failed: ${error.message}`);
  // RLS hides threads in mailboxes without an explicit grant: indistinguishable from missing.
  if (!thread || thread.workspace_id !== ctx.workspace.id) return { status: "not_found" };

  let access;
  try {
    access = await requireMailboxAccess(supabase, user.id, thread.mailbox_id, "read");
  } catch {
    return { status: "denied" };
  }

  const [{ data: msgs, error: mErr }, { data: state }] = await Promise.all([
    supabase
      .from("messages")
      .select(
        "id, direction, lifecycle_state, from_address, reply_to, subject, text_body, html_body, failure_reason, created_at, sent_at, received_at, author_user_id, mailbox_id",
      )
      .eq("thread_id", threadId)
      .neq("direction", "draft")
      .order("created_at", { ascending: true }),
    supabase.from("thread_user_state").select("is_read, is_archived").eq("thread_id", threadId).eq("user_id", user.id).maybeSingle(),
  ]);
  if (mErr) throw new Error(`failed to load messages: ${mErr.message}`);
  const ids = (msgs ?? []).map((m) => m.id);
  const authorIds = [...new Set((msgs ?? []).map((m) => m.author_user_id).filter((x): x is string => !!x))];
  const [rcpt, att, authors] = await Promise.all([
    ids.length ? supabase.from("message_recipients").select("message_id, address, type, delivery_state").in("message_id", ids) : { data: [] },
    ids.length ? supabase.from("attachments").select("id, message_id, filename, mime_type, size_bytes, content_id").in("message_id", ids) : { data: [] },
    authorIds.length ? supabase.from("profiles").select("id, full_name, email").in("id", authorIds) : { data: [] },
  ]);
  const authorName = new Map((authors.data ?? []).map((a) => [a.id, a.full_name ?? a.email]));

  const messages: ThreadMessage[] = (msgs ?? []).map((m) => ({
    ...m,
    recipients: (rcpt.data ?? [])
      .filter((r) => r.message_id === m.id)
      .map((r) => ({ address: r.address, type: r.type, delivery_state: r.delivery_state as DeliveryState })),
    attachments: (att.data ?? [])
      .filter((a) => a.message_id === m.id)
      .map((a) => ({ id: a.id, filename: a.filename, mime_type: a.mime_type, size_bytes: a.size_bytes, content_id: a.content_id })),
    authorName: m.author_user_id ? (authorName.get(m.author_user_id) ?? null) : null,
  }));

  return {
    status: "ok",
    detail: {
      thread: { id: thread.id, subject: thread.subject, mailbox_id: thread.mailbox_id },
      mailboxAddress: access.mailbox.address,
      permission: access.permission,
      canSend: access.permission === "read_send" && access.mailbox.enabled,
      isRead: state?.is_read ?? false,
      isArchived: state?.is_archived ?? false,
      messages,
    },
  };
}
