import { Check, ChevronDown, Mail } from "lucide-react";
import Link from "next/link";
import type { MailboxOption } from "@/lib/data/workspace";
import { inboxHref } from "@/lib/inbox-links";
import { cn } from "@/lib/utils";

export function MailboxSelector({
  slug,
  mailboxes,
  selectedId,
  folder,
  unread,
}: {
  slug: string;
  mailboxes: MailboxOption[];
  selectedId: string | null;
  folder: string;
  unread: Record<string, number>;
}) {
  const current = mailboxes.find((m) => m.id === selectedId);
  const total = Object.values(unread).reduce((a, b) => a + b, 0);
  return (
    <details className="group relative">
      <summary className="flex h-9 cursor-pointer list-none items-center gap-2 rounded-md border border-line-strong bg-surface px-3 text-sm text-ink hover:bg-surface-muted [&::-webkit-details-marker]:hidden">
        <Mail className="size-4 text-muted" aria-hidden />
        <span className="max-w-[14rem] truncate font-medium">{current ? current.address : `All mailboxes`}</span>
        <ChevronDown className="size-3.5 text-muted" aria-hidden />
      </summary>
      <div className="absolute left-0 z-30 mt-1.5 w-80 rounded-lg border border-line bg-surface p-1 shadow-(--shadow-pop)">
        <Link
          href={inboxHref(slug, { folder })}
          className={cn("flex items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-canvas-deep", !current && "bg-accent-soft/60")}
        >
          <span className="font-medium text-ink">All mailboxes</span>
          <span className="flex items-center gap-2">
            {total ? <span className="text-xs font-semibold tabular-nums text-accent">{total}</span> : null}
            {!current ? <Check className="size-4 text-accent" aria-hidden /> : null}
          </span>
        </Link>
        <div className="my-1 border-t border-line" />
        {mailboxes.map((m) => (
          <Link
            key={m.id}
            href={inboxHref(slug, { folder, mailbox: m.id })}
            className={cn("flex items-center justify-between gap-3 rounded-md px-3 py-2 text-sm hover:bg-canvas-deep", m.id === selectedId && "bg-accent-soft/60")}
          >
            <span className="min-w-0">
              <span className="block truncate text-ink">{m.address}</span>
              <span className="block text-xs text-muted">
                {m.permission === "read_send" ? "Read & send" : "Read only"}
                {m.enabled ? "" : " · disabled"}
              </span>
            </span>
            <span className="flex items-center gap-2">
              {unread[m.id] ? <span className="text-xs font-semibold tabular-nums text-accent">{unread[m.id]}</span> : null}
              {m.id === selectedId ? <Check className="size-4 text-accent" aria-hidden /> : null}
            </span>
          </Link>
        ))}
      </div>
    </details>
  );
}
