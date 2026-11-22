import { writeAudit } from "@/lib/audit";
import { requireMailboxAccess } from "@/lib/auth/authz";
import { currentYearMonth } from "@/lib/email/quota";
import { htmlToText } from "@/lib/email/sanitize";
import { isOpenAiConfigured } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import type { WorkspaceContext } from "@/lib/data/workspace";
import { chatCompletion, OpenAiError } from "./openai";

const MAX_MESSAGES = 12;
const MAX_CHARS_PER_MSG = 1800;

export type AiKind = "summarize" | "suggest_reply" | "improve";

export class AiAssistError extends Error {
  constructor(
    message: string,
    public readonly code: "disabled" | "unconfigured" | "quota" | "denied" | "not_found" | "provider",
  ) {
    super(message);
    this.name = "AiAssistError";
  }
}

type ThreadSnippet = {
  threadId: string;
  mailboxId: string;
  subject: string;
  messages: { direction: string; from: string; at: string; body: string }[];
};

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function formatThread(t: ThreadSnippet): string {
  const lines = [`Subject: ${t.subject || "(no subject)"}`, ""];
  for (const m of t.messages) {
    lines.push(`[${m.direction}] From: ${m.from} · ${m.at}`);
    lines.push(m.body || "(empty)");
    lines.push("");
  }
  return lines.join("\n").slice(0, 14_000);
}

async function loadThreadForAi(ctx: WorkspaceContext, threadId: string): Promise<ThreadSnippet> {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new AiAssistError("Conversation not found", "not_found");
  const { data: thread } = await ctx.supabase
    .from("threads")
    .select("id, subject, mailbox_id, workspace_id")
    .eq("id", threadId)
    .maybeSingle();
  if (!thread || thread.workspace_id !== ctx.workspace.id) {
    throw new AiAssistError("Conversation not found", "not_found");
  }
  try {
    await requireMailboxAccess(ctx.supabase, ctx.user.id, thread.mailbox_id, "read");
  } catch {
    throw new AiAssistError("You do not have access to this mailbox", "denied");
  }

  const { data: msgs, error } = await ctx.supabase
    .from("messages")
    .select("direction, from_address, text_body, html_body, created_at, sent_at, received_at")
    .eq("thread_id", threadId)
    .neq("direction", "draft")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  const all = msgs ?? [];
  const slice = all.length > MAX_MESSAGES ? all.slice(-MAX_MESSAGES) : all;
  return {
    threadId: thread.id,
    mailboxId: thread.mailbox_id,
    subject: thread.subject,
    messages: slice.map((m) => {
      const body = (m.text_body?.trim() || (m.html_body ? htmlToText(m.html_body) : "")).trim();
      return {
        direction: m.direction,
        from: m.from_address,
        at: m.received_at ?? m.sent_at ?? m.created_at,
        body: clip(body, MAX_CHARS_PER_MSG),
      };
    }),
  };
}

async function assertAiReady(ctx: WorkspaceContext): Promise<{ instructions: string | null; limit: number }> {
  if (!isOpenAiConfigured()) {
    throw new AiAssistError("AI assist is not configured on this server yet.", "unconfigured");
  }
  const ws = ctx.workspace;
  if (!ws.ai_enabled) {
    throw new AiAssistError("AI assist is turned off for this workspace. An admin can enable it in Settings → AI.", "disabled");
  }
  return { instructions: ws.ai_instructions, limit: ws.monthly_ai_limit };
}

async function consumeQuota(ctx: WorkspaceContext, limit: number): Promise<number> {
  const admin = createAdminClient();
  const yearMonth = currentYearMonth();
  const { data, error } = await admin.rpc("consume_ai_quota", {
    p_workspace_id: ctx.workspace.id,
    p_year_month: yearMonth,
    p_limit: limit,
  });
  if (error) throw new Error(`AI quota: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.allowed) {
    throw new AiAssistError(
      `This workspace has used its monthly AI limit (${limit}). Try again next month or ask a platform admin to raise it.`,
      "quota",
    );
  }
  return row.request_count as number;
}

async function audit(ctx: WorkspaceContext, kind: AiKind, resourceId: string, extra: Record<string, string | number | boolean> = {}) {
  const admin = createAdminClient();
  await writeAudit(admin, {
    workspaceId: ctx.workspace.id,
    actorUserId: ctx.user.id,
    action: `ai.${kind}`,
    resourceType: kind === "improve" ? "compose" : "thread",
    resourceId,
    metadata: { kind, ...extra },
  });
}

function systemPreamble(instructions: string | null): string {
  const base =
    "You help agency staff manage a shared client inbox. Be accurate, concise, and professional. " +
    "Never invent facts that are not in the email. Never include secrets, API keys, or passwords. " +
    "Do not claim you sent or will send email.";
  const custom = instructions?.trim();
  return custom ? `${base}\n\nWorkspace guidance:\n${custom}` : base;
}

export async function summarizeThread(ctx: WorkspaceContext, threadId: string): Promise<string> {
  const { instructions, limit } = await assertAiReady(ctx);
  const thread = await loadThreadForAi(ctx, threadId);
  if (thread.messages.length === 0) throw new AiAssistError("This conversation has no messages to summarize.", "not_found");
  const used = await consumeQuota(ctx, limit);
  try {
    const text = await chatCompletion(
      [
        {
          role: "system",
          content:
            systemPreamble(instructions) +
            "\n\nSummarize the email thread for a busy teammate. Return 3–6 short bullet points covering: who is involved, what they want, decisions or asks, and any deadlines. Plain text only; use '- ' bullets.",
        },
        { role: "user", content: formatThread(thread) },
      ],
      { maxTokens: 500, temperature: 0.3 },
    );
    await audit(ctx, "summarize", threadId, { request_count: used, message_count: thread.messages.length });
    return text;
  } catch (e) {
    if (e instanceof OpenAiError) throw new AiAssistError(e.message, "provider");
    throw e;
  }
}

export async function suggestReply(ctx: WorkspaceContext, threadId: string): Promise<string> {
  const { instructions, limit } = await assertAiReady(ctx);
  const thread = await loadThreadForAi(ctx, threadId);
  if (thread.messages.length === 0) throw new AiAssistError("Nothing to reply to yet.", "not_found");
  // Suggesting a reply requires send access on the mailbox.
  try {
    await requireMailboxAccess(ctx.supabase, ctx.user.id, thread.mailboxId, "send");
  } catch {
    throw new AiAssistError("You need send access on this mailbox to draft a reply.", "denied");
  }
  const used = await consumeQuota(ctx, limit);
  try {
    const text = await chatCompletion(
      [
        {
          role: "system",
          content:
            systemPreamble(instructions) +
            "\n\nDraft a reply the user can send. Write only the email body in plain text (no subject line, no markdown fences). " +
            "Match a helpful professional tone. Keep it under ~200 words unless the thread clearly needs more. " +
            "Do not include a quoted history of prior messages.",
        },
        { role: "user", content: formatThread(thread) },
      ],
      { maxTokens: 700, temperature: 0.5 },
    );
    await audit(ctx, "suggest_reply", threadId, { request_count: used, message_count: thread.messages.length });
    return text;
  } catch (e) {
    if (e instanceof OpenAiError) throw new AiAssistError(e.message, "provider");
    throw e;
  }
}

export async function improveDraft(
  ctx: WorkspaceContext,
  opts: { draft: string; subject?: string; tone?: "professional" | "friendly" | "shorter" },
): Promise<string> {
  const { instructions, limit } = await assertAiReady(ctx);
  const draft = opts.draft.trim();
  if (!draft) throw new AiAssistError("Write a draft first, then ask AI to improve it.", "not_found");
  if (draft.length > 12_000) throw new AiAssistError("Draft is too long to improve in one pass.", "denied");
  const used = await consumeQuota(ctx, limit);
  const tone =
    opts.tone === "friendly"
      ? "Make it warmer and more approachable while staying professional."
      : opts.tone === "shorter"
        ? "Tighten the wording; cut fluff while keeping the meaning."
        : "Polish for clear, professional email tone.";
  try {
    const text = await chatCompletion(
      [
        {
          role: "system",
          content:
            systemPreamble(instructions) +
            `\n\nRewrite the user's email draft. ${tone} Return only the improved body as plain text.`,
        },
        {
          role: "user",
          content: `Subject: ${opts.subject?.trim() || "(none)"}\n\nDraft:\n${draft}`,
        },
      ],
      { maxTokens: 700, temperature: 0.4 },
    );
    await audit(ctx, "improve", ctx.workspace.id, { request_count: used, tone: opts.tone ?? "professional" });
    return text;
  } catch (e) {
    if (e instanceof OpenAiError) throw new AiAssistError(e.message, "provider");
    throw e;
  }
}
