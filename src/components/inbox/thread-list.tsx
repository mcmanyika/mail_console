import { AlertCircle, Clock, FileEdit } from "lucide-react";
import Link from "next/link";
import { displayName, formatListDate, initials } from "@/lib/format";
import type { ListItem } from "@/lib/data/inbox";
import { composeHref, inboxHref } from "@/lib/inbox-links";
import { cn } from "@/lib/utils";

export function ThreadList({
  slug,
  items,
  folder,
  mailboxId,
  q,
  activeThread,
  mailboxLabels,
  truncated,
}: {
  slug: string;
  items: ListItem[];
  folder: string;
  mailboxId: string | null;
  q: string;
  activeThread: string | null;
  mailboxLabels: Record<string, string> | null;
  truncated: boolean;
}) {
  return (
    <ul className="divide-y divide-line" aria-label={`${folder} conversations`}>
      {items.map((it) => {
        const href = it.draftId
          ? composeHref(slug, { draft: it.draftId })
          : inboxHref(slug, { folder, mailbox: mailboxId, q, thread: it.threadId });
        const active = !!activeThread && it.threadId === activeThread;
        const isOutbound = folder === "sent" || it.party === "You" || it.party.startsWith("To:");
        const partyLabel = it.party.startsWith("To:") || it.party === "You" ? it.party : displayName(it.party);
        return (
          <li key={it.key}>
            <Link
              href={href}
              aria-current={active ? "true" : undefined}
              className={cn(
                "group relative flex gap-3 px-4 py-3 transition-colors hover:bg-surface-muted",
                active && "bg-accent-soft/50 hover:bg-accent-soft/50",
              )}
            >
              {it.unread ? <span className="absolute left-1.5 top-5 size-1.5 rounded-full bg-accent" aria-label="Unread" /> : null}
              <span
                className={cn(
                  "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                  isOutbound ? "bg-canvas-deep text-muted" : "bg-ink text-white",
                )}
                aria-hidden
              >
                {it.draftId ? <FileEdit className="size-4" /> : initials(it.party.replace(/^To:\s*/, ""))}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className={cn("truncate text-sm", it.unread ? "font-semibold text-ink" : "font-medium text-ink-2")}>{partyLabel}</span>
                  <time className="shrink-0 text-xs tabular-nums text-muted" dateTime={it.at}>
                    {formatListDate(it.at)}
                  </time>
                </span>
                <span className={cn("block truncate text-[13px]", it.unread ? "font-semibold text-ink" : "text-ink-2")}>{it.subject}</span>
                <span className="mt-0.5 flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{it.snippet || "No preview"}</span>
                  {it.state === "queued" ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-warn">
                      <Clock className="size-3" aria-hidden /> Queued
                    </span>
                  ) : null}
                  {it.state === "failed" ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-danger">
                      <AlertCircle className="size-3" aria-hidden /> Failed
                    </span>
                  ) : null}
                  {it.messageCount > 1 ? (
                    <span className="shrink-0 rounded bg-canvas-deep px-1.5 text-xs tabular-nums text-muted">{it.messageCount}</span>
                  ) : null}
                </span>
                {mailboxLabels && mailboxLabels[it.mailboxId] ? (
                  <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-2">
                    {mailboxLabels[it.mailboxId]}
                  </span>
                ) : null}
              </span>
            </Link>
          </li>
        );
      })}
      {truncated ? (
        <li className="px-4 py-3 text-center text-xs text-muted">Showing the most recent conversations. Use search to narrow down.</li>
      ) : null}
    </ul>
  );
}
