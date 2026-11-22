"use client";

import { Sparkles } from "lucide-react";
import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { SubmitButton } from "@/components/ui/submit-button";
import { summarizeThreadAction } from "@/lib/actions/ai";
import { idleState } from "@/lib/actions/state";

export function ThreadAiSummary({ slug, threadId }: { slug: string; threadId: string }) {
  const [state, action] = useActionState(summarizeThreadAction, idleState);
  const summary = typeof state.data?.summary === "string" ? state.data.summary : null;

  return (
    <div className="mt-3 rounded-md border border-line bg-surface-muted/40 px-3 py-2.5">
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="threadId" value={threadId} />
        <SubmitButton variant="secondary" size="sm" pendingLabel="Summarizing…">
          <Sparkles className="size-4" aria-hidden /> Summarize
        </SubmitButton>
        <span className="text-xs text-muted">AI summary for this conversation</span>
      </form>
      {state.status === "error" && state.message ? (
        <Alert tone="danger" className="mt-2">
          {state.message}
        </Alert>
      ) : null}
      {summary ? (
        <div className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2" role="status">
          {summary}
        </div>
      ) : null}
    </div>
  );
}
