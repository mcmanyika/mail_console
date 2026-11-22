import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { InboxToolbar } from "@/components/inbox/inbox-toolbar";
import { EmptyFolder, MailboxDenied, NoMailboxAccess, NoSelection } from "@/components/inbox/states";
import { ThreadList } from "@/components/inbox/thread-list";
import { ThreadView } from "@/components/inbox/thread-view";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { getThread, getUnreadCounts, listFolder, parseFolder } from "@/lib/data/inbox";
import { getReadableMailboxes, getWorkspaceContext } from "@/lib/data/workspace";
import { first } from "@/lib/format";
import { inboxHref } from "@/lib/inbox-links";
import { Lock, SearchX } from "lucide-react";

export const metadata: Metadata = { title: "Inbox" };

type Params = Promise<{ slug: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;

export default function InboxPage({ params, searchParams }: { params: Params; searchParams: SP }) {
  return (
    <Suspense fallback={<InboxSkeleton />}>
      <InboxBody params={params} searchParams={searchParams} />
    </Suspense>
  );
}

function InboxSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="status" aria-label="Loading inbox">
      <div className="h-[53px] shrink-0 border-b border-line bg-surface" />
      <div className="flex min-h-0 flex-1">
        <div className="w-full border-r border-line bg-surface p-4 lg:w-[400px]">
          <SkeletonRows rows={7} />
        </div>
        <div className="hidden flex-1 p-8 lg:block">
          <Skeleton className="h-8 w-2/3" />
        </div>
      </div>
    </div>
  );
}

async function InboxBody({ params, searchParams }: { params: Params; searchParams: SP }) {
  // Relative timestamps use Date.now(); wait for the request (Next 16 cacheComponents).
  await connection();
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const ctx = await getWorkspaceContext(slug);
  const mailboxes = await getReadableMailboxes(slug);
  if (mailboxes.length === 0) return <NoMailboxAccess slug={slug} role={ctx.role} />;

  const folder = parseFolder(first(sp.folder));
  const mailboxParam = first(sp.mailbox) ?? null;
  const q = (first(sp.q) ?? "").slice(0, 80);
  const threadParam = first(sp.thread) ?? null;
  const queued = first(sp.queued) === "1";

  if (mailboxParam && !mailboxes.some((m) => m.id === mailboxParam)) return <MailboxDenied slug={slug} />;

  const unread = await getUnreadCounts(slug);
  const listPath = inboxHref(slug, { folder, mailbox: mailboxParam, q });
  const hasThread = !!threadParam;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <InboxToolbar slug={slug} mailboxes={mailboxes} mailboxId={mailboxParam} folder={folder} q={q} unread={unread.byMailbox} />
      <div className="flex min-h-0 flex-1">
        <section
          aria-label="Conversation list"
          className={`scroll-quiet min-h-0 w-full shrink-0 overflow-y-auto border-r border-line bg-surface lg:flex lg:w-[400px] lg:flex-col ${hasThread ? "hidden" : "block"}`}
        >
          <Suspense fallback={<div className="p-4"><SkeletonRows rows={8} /></div>}>
            <ListBody
              slug={slug}
              folder={folder}
              mailboxId={mailboxParam}
              q={q}
              activeThread={threadParam}
              showMailboxLabel={!mailboxParam && mailboxes.length > 1}
              labels={Object.fromEntries(mailboxes.map((m) => [m.id, m.address]))}
            />
          </Suspense>
        </section>
        <section aria-label="Reading pane" className={`min-h-0 min-w-0 flex-1 flex-col ${hasThread ? "flex" : "hidden lg:flex"}`}>
          {threadParam ? (
            <Suspense
              key={threadParam}
              fallback={
                <div className="p-6">
                  <Skeleton className="mb-4 h-7 w-2/3" />
                  <SkeletonRows rows={4} />
                </div>
              }
            >
              <ReadingPane slug={slug} threadId={threadParam} mailboxId={mailboxParam} listPath={listPath} queued={queued} />
            </Suspense>
          ) : (
            <NoSelection />
          )}
        </section>
      </div>
    </div>
  );
}

async function ListBody({
  slug,
  folder,
  mailboxId,
  q,
  activeThread,
  showMailboxLabel,
  labels,
}: {
  slug: string;
  folder: ReturnType<typeof parseFolder>;
  mailboxId: string | null;
  q: string;
  activeThread: string | null;
  showMailboxLabel: boolean;
  labels: Record<string, string>;
}) {
  const { items, truncated } = await listFolder(slug, { folder, mailboxId, q });
  if (items.length === 0) return <EmptyFolder folder={folder} searching={!!q} />;
  return (
    <ThreadList
      slug={slug}
      items={items}
      folder={folder}
      mailboxId={mailboxId}
      q={q}
      activeThread={activeThread}
      mailboxLabels={showMailboxLabel ? labels : null}
      truncated={truncated}
    />
  );
}

async function ReadingPane({
  slug,
  threadId,
  mailboxId,
  listPath,
  queued,
}: {
  slug: string;
  threadId: string;
  mailboxId: string | null;
  listPath: string;
  queued: boolean;
}) {
  const result = await getThread(slug, threadId);
  if (result.status === "denied") {
    return (
      <EmptyState
        className="flex-1"
        icon={Lock}
        title="You can't read this conversation"
        description="Reading mail needs an explicit grant on its mailbox."
        action={<Link href={listPath} className="text-sm font-medium text-accent hover:underline">← Back to list</Link>}
      />
    );
  }
  if (result.status === "not_found") {
    return (
      <EmptyState
        className="flex-1"
        icon={SearchX}
        title="Conversation not found"
        description="It may have been removed, or you may not have access to its mailbox."
        action={<Link href={listPath} className="text-sm font-medium text-accent hover:underline">← Back to list</Link>}
      />
    );
  }
  return <ThreadView slug={slug} detail={result.detail} backHref={listPath} returnTo={listPath} mailboxId={mailboxId} queued={queued} />;
}
