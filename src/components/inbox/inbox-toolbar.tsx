import { Search, X } from "lucide-react";
import Link from "next/link";
import type { MailboxOption } from "@/lib/data/workspace";
import { inboxHref } from "@/lib/inbox-links";
import { MailboxSelector } from "./mailbox-selector";

export function InboxToolbar({
  slug,
  mailboxes,
  mailboxId,
  folder,
  q,
  unread,
}: {
  slug: string;
  mailboxes: MailboxOption[];
  mailboxId: string | null;
  folder: string;
  q: string;
  unread: Record<string, number>;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2.5 md:px-4">
      <MailboxSelector slug={slug} mailboxes={mailboxes} selectedId={mailboxId} folder={folder} unread={unread} />
      <form action={`/w/${slug}/inbox`} method="get" role="search" className="relative min-w-48 flex-1 sm:max-w-md">
        <input type="hidden" name="folder" value={folder} />
        {mailboxId ? <input type="hidden" name="mailbox" value={mailboxId} /> : null}
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-2" aria-hidden />
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder={`Search ${folder}…`}
          aria-label="Search mail"
          className="h-9 w-full rounded-md border border-line-strong bg-canvas/60 pl-9 pr-8 text-sm text-ink placeholder:text-muted-2 focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/20"
        />
        {q ? (
          <Link
            href={inboxHref(slug, { folder, mailbox: mailboxId })}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:bg-canvas-deep hover:text-ink"
          >
            <X className="size-3.5" aria-hidden />
          </Link>
        ) : null}
      </form>
    </div>
  );
}
