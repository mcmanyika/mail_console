"use server";

import { AiAssistError, improveDraft, suggestReply, summarizeThread } from "@/lib/ai/assist";
import { requireWorkspaceAction } from "@/lib/data/workspace";
import { formString, guarded } from "./guard";
import { fail, ok, type ActionState } from "./state";

function mapAiError(e: unknown): ActionState {
  if (e instanceof AiAssistError) return fail(e.message);
  throw e;
}

export async function summarizeThreadAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return guarded(async () => {
    const slug = formString(formData, "slug");
    const threadId = formString(formData, "threadId");
    const ctx = await requireWorkspaceAction({ slug }, "member");
    try {
      const summary = await summarizeThread(ctx, threadId);
      return ok(undefined, { data: { summary } });
    } catch (e) {
      return mapAiError(e);
    }
  });
}

export async function suggestReplyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return guarded(async () => {
    const slug = formString(formData, "slug");
    const threadId = formString(formData, "threadId");
    const ctx = await requireWorkspaceAction({ slug }, "member");
    try {
      const draft = await suggestReply(ctx, threadId);
      return ok(undefined, { data: { draft } });
    } catch (e) {
      return mapAiError(e);
    }
  });
}

export async function improveDraftAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return guarded(async () => {
    const slug = formString(formData, "slug");
    const draft = formString(formData, "draft");
    const subject = formString(formData, "subject");
    const toneRaw = formString(formData, "tone");
    const tone =
      toneRaw === "friendly" || toneRaw === "shorter" || toneRaw === "professional" ? toneRaw : "professional";
    const ctx = await requireWorkspaceAction({ slug }, "member");
    try {
      const improved = await improveDraft(ctx, { draft, subject, tone });
      return ok(undefined, { data: { draft: improved } });
    } catch (e) {
      return mapAiError(e);
    }
  });
}
