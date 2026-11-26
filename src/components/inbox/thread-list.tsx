"use client";

import { AlertCircle, Archive, Clock, FileEdit, MailOpen, Trash2, Undo2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ConfirmButton } from "@/components/ui/confirm-dialog";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  bulkArchiveThreadsAction,
  bulkDeleteThreadsAction,
  bulkDiscardDraftsAction,
  bulkMarkUnreadAction,
} from "@/lib/actions/inbox";
import type { ListItem } from "@/lib/data/inbox";
import { displayName, formatListDate, initials } from "@/lib/format";
import { composeHref, inboxHref } from "@/lib/inbox-links";
import { cn } from "@/lib/utils";

export function ThreadList({
  slug,
  items,
  folder,
  mailboxId,
  q,
  page = 1,
  activeThread,
  truncated,
}: {
  slug: string;
  items: ListItem[];
  folder: string;
  mailboxId: string | null;
  q: string;
  page?: number;
  activeThread: string | null;
  truncated: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const isDrafts = folder === "drafts";
  const returnTo = inboxHref(slug, {
    folder,
    mailbox: mailboxId,
    q,
    extra: page > 1 ? { page: String(page) } : undefined,
  });
  const allKeys = useMemo(() => items.map((it) => it.key), [items]);
  const allKeysSig = allKeys.join("\0");

  useEffect(() => {
    setSelected(new Set());
  }, [folder, mailboxId, q, page, allKeysSig]);

  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));
  const someSelected = selected.size > 0 && !allSelected;
  const selectedItems = useMemo(() => items.filter((it) => selected.has(it.key)), [items, selected]);
  const selectedThreadIds = selectedItems.map((it) => it.threadId).filter((id): id is string => !!id);
  const selectedDraftIds = selectedItems.map((it) => it.draftId).filter((id): id is string => !!id);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => {
      if (allKeys.every((k) => prev.has(k))) return new Set();
      return new Set(allKeys);
    });
  };

  return (
    <div>
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-ink-2">
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected;
            }}
            onChange={toggleAll}
            className="size-4 accent-[#4F46E5]"
            aria-label={allSelected ? "Deselect all conversations" : "Select all conversations"}
          />
          <span className="tabular-nums text-muted">
            {selected.size > 0 ? `${selected.size} selected` : "Select"}
          </span>
        </label>

        {selected.size > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {isDrafts ? (
              <ConfirmButton
                action={bulkDiscardDraftsAction}
                hiddenFields={{ slug }}
                triggerLabel={
                  <>
                    <Trash2 className="size-4" aria-hidden /> Discard
                  </>
                }
                triggerVariant="danger-ghost"
                triggerSize="sm"
                title={`Discard ${selectedDraftIds.length} ${selectedDraftIds.length === 1 ? "draft" : "drafts"}?`}
                confirmLabel="Discard"
                description={<p>Selected drafts will be permanently deleted, including any attachments.</p>}
              >
                {selectedDraftIds.map((id) => (
                  <input key={id} type="hidden" name="draftId" value={id} />
                ))}
              </ConfirmButton>
            ) : (
              <>
                <form action={bulkArchiveThreadsAction} className="inline">
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <input type="hidden" name="archived" value={folder === "archive" ? "0" : "1"} />
                  {selectedThreadIds.map((id) => (
                    <input key={`archive-${id}`} type="hidden" name="threadId" value={id} />
                  ))}
                  <SubmitButton variant="secondary" size="sm">
                    {folder === "archive" ? <Undo2 className="size-4" aria-hidden /> : <Archive className="size-4" aria-hidden />}
                    {folder === "archive" ? "Move to inbox" : "Archive"}
                  </SubmitButton>
                </form>
                <form action={bulkMarkUnreadAction} className="inline">
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  {selectedThreadIds.map((id) => (
                    <input key={`unread-${id}`} type="hidden" name="threadId" value={id} />
                  ))}
                  <SubmitButton variant="secondary" size="sm">
                    <MailOpen className="size-4" aria-hidden /> Mark unread
                  </SubmitButton>
                </form>
                <ConfirmButton
                  action={bulkDeleteThreadsAction}
                  hiddenFields={{ slug, returnTo }}
                  triggerLabel={
                    <>
                      <Trash2 className="size-4" aria-hidden /> Delete
                    </>
                  }
                  triggerVariant="danger-ghost"
                  triggerSize="sm"
                  title={`Delete ${selectedThreadIds.length} ${selectedThreadIds.length === 1 ? "conversation" : "conversations"}?`}
                  confirmLabel="Delete permanently"
                  description={
                    <>
                      <p>
                        This permanently removes the selected conversations and their attachments for everyone with
                        access to those mailboxes.
                      </p>
                      <p className="mt-2">This cannot be undone.</p>
                    </>
                  }
                >
                  {selectedThreadIds.map((id) => (
                    <input key={`delete-${id}`} type="hidden" name="threadId" value={id} />
                  ))}
                </ConfirmButton>
              </>
            )}
          </div>
        ) : null}
      </div>

      <ul className="divide-y divide-line" aria-label={`${folder} conversations`}>
        {items.map((it) => {
          const href = it.draftId
            ? composeHref(slug, { draft: it.draftId })
            : inboxHref(slug, {
                folder,
                mailbox: mailboxId,
                q,
                thread: it.threadId,
                extra: page > 1 ? { page: String(page) } : undefined,
              });
          const active = !!activeThread && it.threadId === activeThread;
          const isOutbound = folder === "sent" || it.party === "You" || it.party.startsWith("To:");
          const partyLabel = it.party.startsWith("To:") || it.party === "You" ? it.party : displayName(it.party);
          const checked = selected.has(it.key);
          return (
            <li key={it.key} className={cn("flex items-stretch", active && "bg-accent-soft/50")}>
              <div className="flex shrink-0 items-start px-3 pt-4">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(it.key)}
                  onClick={(e) => e.stopPropagation()}
                  className="size-4 accent-[#4F46E5]"
                  aria-label={`Select ${partyLabel}`}
                />
              </div>
              <Link
                href={href}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "group relative flex min-w-0 flex-1 gap-3 py-3 pr-4 transition-colors hover:bg-surface-muted",
                  active && "hover:bg-accent-soft/50",
                )}
              >
                {it.unread ? <span className="absolute left-0 top-5 size-1.5 rounded-full bg-accent" aria-label="Unread" /> : null}
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
                    <span className={cn("truncate text-sm", it.unread ? "font-semibold text-ink" : "font-medium text-ink-2")}>
                      {partyLabel}
                    </span>
                    <time className="shrink-0 text-xs tabular-nums text-muted" dateTime={it.at}>
                      {formatListDate(it.at)}
                    </time>
                  </span>
                  <span className="mt-0.5 flex items-center gap-2">
                    <span className={cn("min-w-0 flex-1 truncate text-[13px]", it.unread ? "font-semibold text-ink" : "text-ink-2")}>
                      {it.subject}
                    </span>
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
                      <span className="shrink-0 rounded bg-canvas-deep px-1.5 text-xs tabular-nums text-muted">
                        {it.messageCount}
                      </span>
                    ) : null}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
        {truncated ? (
          <li className="px-4 py-3 text-center text-xs text-muted">
            Showing the most recent conversations. Use search to narrow down.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
