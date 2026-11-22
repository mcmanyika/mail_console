"use client";

import { Loader2, Sparkles, Wand2 } from "lucide-react";
import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { improveDraftAction, suggestReplyAction } from "@/lib/actions/ai";
import { idleState, type ActionState } from "@/lib/actions/state";

type Props = {
  slug: string;
  threadId: string | null;
  subject: string;
  body: string;
  onApply: (text: string) => void;
};

function fd(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(entries)) data.set(k, v);
  return data;
}

export function ComposeAiAssist({ slug, threadId, subject, body, onApply }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"suggest" | "improve" | "shorter" | "friendly" | null>(null);

  const run = (kind: NonNullable<typeof busy>, action: () => Promise<ActionState>) => {
    setError(null);
    setBusy(kind);
    startTransition(async () => {
      try {
        const state = await action();
        if (state.status === "error") {
          setError(state.message ?? "AI request failed");
        } else if (typeof state.data?.draft === "string") {
          onApply(state.data.draft);
        }
      } catch {
        setError("Something went wrong. Please try again.");
      } finally {
        setBusy(null);
      }
    });
  };

  const suggest = () => {
    if (!threadId) return;
    run("suggest", () => suggestReplyAction(idleState, fd({ slug, threadId })));
  };

  const improve = (tone: "professional" | "shorter" | "friendly", kind: NonNullable<typeof busy>) => {
    if (!body.trim()) return;
    run(kind, () => improveDraftAction(idleState, fd({ slug, draft: body, subject, tone })));
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {threadId ? (
          <button type="button" onClick={suggest} disabled={pending} className={buttonClasses("secondary", "sm")}>
            {busy === "suggest" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
            Suggest reply
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => improve("professional", "improve")}
          disabled={pending || !body.trim()}
          className={buttonClasses("secondary", "sm")}
        >
          {busy === "improve" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Wand2 className="size-4" aria-hidden />}
          Improve draft
        </button>
        <button
          type="button"
          onClick={() => improve("shorter", "shorter")}
          disabled={pending || !body.trim()}
          className={buttonClasses("ghost", "sm")}
        >
          {busy === "shorter" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Make shorter
        </button>
        <button
          type="button"
          onClick={() => improve("friendly", "friendly")}
          disabled={pending || !body.trim()}
          className={buttonClasses("ghost", "sm")}
        >
          {busy === "friendly" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Friendlier
        </button>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
