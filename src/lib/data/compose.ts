import { format } from "date-fns";
import { htmlToText } from "@/lib/email/sanitize";
import { displayName, parseAddress } from "@/lib/format";
import type { ComposeMode } from "@/lib/actions/compose";
import { getReadableMailboxes, getWorkspaceContext, type MailboxOption } from "./workspace";

export type ComposeInit = {
  slug: string;
  mode: ComposeMode | "draft";
  parentId: string | null;
  /** Set for reply/forward/resend/draft-in-thread so AI can suggest from the conversation. */
  threadId: string | null;
  draftId: string | null;
  mailboxId: string;
  lockMailbox: boolean;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  attachments: { id: string; filename: string; size: number }[];
  forwardable: { id: string; filename: string; size: number }[];
  sendMailboxes: { id: string; address: string; label: string }[];
  templates: { id: string; name: string; subject: string; body: string }[];
  workspaceActive: boolean;
  aiEnabled: boolean;
  heading: string;
};

export type ComposeLoad =
  | { status: "ok"; init: ComposeInit }
  | { status: "no_send_access" }
  | { status: "denied"; message: string }
  | { status: "not_found" };

const MODES: ComposeMode[] = ["new", "reply", "replyAll", "forward", "resend"];
const ID_RE = /^[0-9a-f-]{36}$/i;

function prefix(subject: string, p: "Re" | "Fwd"): string {
  const re = p === "Re" ? /^\s*re\s*:/i : /^\s*(fwd?|fw)\s*:/i;
  return re.test(subject) ? subject : `${p}: ${subject}`;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
}

export async function loadCompose(
  slug: string,
  params: { mode?: string; message?: string; draft?: string; mailbox?: string },
): Promise<ComposeLoad> {
  const ctx = await getWorkspaceContext(slug);
  const readable = await getReadableMailboxes(slug);
  const sendable: MailboxOption[] = readable.filter((m) => m.permission === "read_send" && m.enabled);
  if (sendable.length === 0) return { status: "no_send_access" };
  const { supabase } = ctx;

  const [{ data: tpls }] = await Promise.all([
    supabase.from("email_templates").select("id, name, subject, body_text").eq("workspace_id", ctx.workspace.id).order("name"),
  ]);
  const base = {
    slug,
    sendMailboxes: sendable.map((m) => ({ id: m.id, address: m.address, label: m.displayName ? `${m.displayName} <${m.address}>` : m.address })),
    templates: (tpls ?? []).map((t) => ({ id: t.id, name: t.name, subject: t.subject, body: t.body_text ?? "" })),
    workspaceActive: ctx.workspace.status === "active",
    aiEnabled: ctx.workspace.ai_enabled,
  };

  // ---- existing draft ----
  if (params.draft) {
    if (!ID_RE.test(params.draft)) return { status: "not_found" };
    const { data: d } = await supabase
      .from("messages")
      .select("id, mailbox_id, thread_id, subject, text_body, workspace_id")
      .eq("id", params.draft)
      .eq("direction", "draft")
      .eq("author_user_id", ctx.user.id)
      .maybeSingle();
    if (!d || d.workspace_id !== ctx.workspace.id) return { status: "not_found" };
    if (!sendable.some((m) => m.id === d.mailbox_id)) {
      return { status: "denied", message: "You no longer have send access to this draft's mailbox." };
    }
    const [{ data: rcpts }, { data: atts }] = await Promise.all([
      supabase.from("message_recipients").select("address, type").eq("message_id", d.id),
      supabase.from("attachments").select("id, filename, size_bytes").eq("message_id", d.id),
    ]);
    const list = (t: string) => (rcpts ?? []).filter((r) => r.type === t).map((r) => r.address).join(", ");
    return {
      status: "ok",
      init: {
        ...base,
        mode: "draft",
        parentId: null,
        threadId: d.thread_id,
        draftId: d.id,
        mailboxId: d.mailbox_id,
        lockMailbox: d.thread_id !== null,
        to: list("to"),
        cc: list("cc"),
        bcc: list("bcc"),
        subject: d.subject,
        body: d.text_body ?? "",
        attachments: (atts ?? []).map((a) => ({ id: a.id, filename: a.filename, size: Number(a.size_bytes) })),
        forwardable: [],
        heading: d.thread_id ? "Reply draft" : "Draft",
      },
    };
  }

  const mode = (MODES as string[]).includes(params.mode ?? "") ? (params.mode as ComposeMode) : "new";
  const preferred = sendable.find((m) => m.id === params.mailbox) ?? sendable[0];

  if (mode === "new" || !params.message) {
    return {
      status: "ok",
      init: {
        ...base,
        mode: "new",
        parentId: null,
        threadId: null,
        draftId: null,
        mailboxId: preferred.id,
        lockMailbox: false,
        to: "",
        cc: "",
        bcc: "",
        subject: "",
        body: "",
        attachments: [],
        forwardable: [],
        heading: "New message",
      },
    };
  }

  // ---- reply / forward / resend ----
  if (!ID_RE.test(params.message)) return { status: "not_found" };
  // RLS only returns the message when the caller can read its mailbox.
  const { data: parent } = await supabase
    .from("messages")
    .select("id, workspace_id, mailbox_id, thread_id, direction, from_address, reply_to, subject, text_body, html_body, created_at, received_at, sent_at")
    .eq("id", params.message)
    .neq("direction", "draft")
    .maybeSingle();
  if (!parent || parent.workspace_id !== ctx.workspace.id) return { status: "not_found" };
  const mailbox = readable.find((m) => m.id === parent.mailbox_id);
  if (!mailbox) return { status: "not_found" };
  if (mailbox.permission !== "read_send" || !mailbox.enabled) {
    return {
      status: "denied",
      message: mailbox.enabled
        ? "You have read-only access to this mailbox, so you can't reply, forward or send from it."
        : "This mailbox is disabled, so it can't send mail right now.",
    };
  }

  const [{ data: rcpts }, { data: atts }] = await Promise.all([
    supabase.from("message_recipients").select("address, type").eq("message_id", parent.id),
    supabase.from("attachments").select("id, filename, size_bytes, content_id").eq("message_id", parent.id),
  ]);
  const text = (parent.text_body?.trim() ? parent.text_body : parent.html_body ? htmlToText(parent.html_body) : "").replace(/\r\n/g, "\n");
  const when = parent.received_at ?? parent.sent_at ?? parent.created_at;
  const whenLabel = format(new Date(when), "EEE, MMM d, yyyy 'at' h:mm a");
  const own = mailbox.address.toLowerCase();
  const addrs = (type: string) => (rcpts ?? []).filter((r) => r.type === type).map((r) => r.address);
  const attachments = (atts ?? []).map((a) => ({ id: a.id, filename: a.filename, size: Number(a.size_bytes) }));

  const common = {
    ...base,
    parentId: parent.id,
    threadId: parent.thread_id,
    draftId: null,
    mailboxId: mailbox.id,
    bcc: "",
    attachments: [] as ComposeInit["attachments"],
  };

  if (mode === "reply" || mode === "replyAll") {
    const replyTo = parent.direction === "inbound" ? [parseAddress(parent.reply_to || parent.from_address).email] : addrs("to");
    const to = replyTo.filter((a) => a !== own);
    const cc =
      mode === "replyAll"
        ? [...addrs("to"), ...addrs("cc")].filter((a, i, arr) => a !== own && !to.includes(a) && arr.indexOf(a) === i)
        : [];
    return {
      status: "ok",
      init: {
        ...common,
        mode,
        lockMailbox: true,
        to: to.join(", "),
        cc: cc.join(", "),
        subject: prefix(parent.subject, "Re"),
        body: `\n\nOn ${whenLabel}, ${displayName(parent.from_address)} wrote:\n${quote(text)}`,
        forwardable: [],
        heading: mode === "reply" ? "Reply" : "Reply all",
      },
    };
  }

  if (mode === "forward") {
    const header = [
      "---------- Forwarded message ---------",
      `From: ${parent.from_address}`,
      `Date: ${whenLabel}`,
      `Subject: ${parent.subject}`,
      `To: ${addrs("to").join(", ")}`,
      ...(addrs("cc").length ? [`Cc: ${addrs("cc").join(", ")}`] : []),
    ].join("\n");
    return {
      status: "ok",
      init: {
        ...common,
        mode,
        lockMailbox: false,
        to: "",
        cc: "",
        subject: prefix(parent.subject, "Fwd"),
        body: `\n\n${header}\n\n${text}`,
        forwardable: attachments,
        heading: "Forward",
      },
    };
  }

  // resend a failed message
  return {
    status: "ok",
    init: {
      ...common,
      mode: "resend",
      lockMailbox: true,
      to: addrs("to").join(", "),
      cc: addrs("cc").join(", "),
      bcc: addrs("bcc").join(", "),
      subject: parent.subject,
      body: parent.text_body ?? text,
      forwardable: attachments,
      heading: "Edit & resend",
    },
  };
}
