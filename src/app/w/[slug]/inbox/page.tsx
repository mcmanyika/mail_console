import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { InboxToolbar } from "@/components/inbox/inbox-toolbar";
import { EmptyFolder, MailboxDenied, NoMailboxAccess, NoSelection } from "@/components/inbox/states";
import { ThreadList } from "@/components/inbox/thread-list";
import { ThreadView } from "@/components/inbox/thread-view";
import { LinkButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { getThread, getUnreadCounts, listFolder, parseFolder } from "@/lib/data/inbox";
import { getReadableMailboxes, getWorkspaceContext } from "@/lib/data/workspace";
import { first, formatNumber } from "@/lib/format";
import { inboxHref } from "@/lib/inbox-links";
import { Lock, SearchX } from "lucide-react";

export const metadata: Metadata = { title: "Inbox" };

const INBOX_PAGE_SIZE = 10;

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
  const page = Math.max(1, Number.parseInt(first(sp.page) ?? "1", 10) || 1);
  const threadParam = first(sp.thread) ?? null;
  if (mailboxParam && !mailboxes.some((m) => m.id === mailboxParam)) return <MailboxDenied slug={slug} />;

  const unread = await getUnreadCounts(slug);
  const listPath = inboxHref(slug, {
    folder,
    mailbox: mailboxParam,
    q,
    extra: page > 1 ? { page: String(page) } : undefined,
  });
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
              page={page}
              activeThread={threadParam}
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
              <ReadingPane slug={slug} threadId={threadParam} mailboxId={mailboxParam} listPath={listPath} />
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
  page,
  activeThread,
}: {
  slug: string;
  folder: ReturnType<typeof parseFolder>;
  mailboxId: string | null;
  q: string;
  page: number;
  activeThread: string | null;
}) {
  const { items, truncated } = await listFolder(slug, { folder, mailboxId, q });
  if (items.length === 0) return <EmptyFolder folder={folder} searching={!!q} />;

  const totalPages = Math.max(1, Math.ceil(items.length / INBOX_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * INBOX_PAGE_SIZE;
  const pagedItems = items.slice(pageStart, pageStart + INBOX_PAGE_SIZE);

  return (
    <>
      <ThreadList
        slug={slug}
        items={pagedItems}
        folder={folder}
        mailboxId={mailboxId}
        q={q}
        page={currentPage}
        activeThread={activeThread}
        truncated={truncated}
      />
      <InboxPager
        slug={slug}
        folder={folder}
        mailboxId={mailboxId}
        q={q}
        page={currentPage}
        pageSize={INBOX_PAGE_SIZE}
        total={items.length}
      />
    </>
  );
}

function InboxPager({
  slug,
  folder,
  mailboxId,
  q,
  page,
  pageSize,
  total,
}: {
  slug: string;
  folder: string;
  mailboxId: string | null;
  q: string;
  page: number;
  pageSize: number;
  total: number;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const href = (p: number) =>
    inboxHref(slug, {
      folder,
      mailbox: mailboxId,
      q,
      extra: p > 1 ? { page: String(p) } : undefined,
    });

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-3 py-2.5">
      <p className="text-[12px] text-muted">
        {from}–{to} of {formatNumber(total)}
      </p>
      <div className="flex items-center gap-1.5">
        {page > 1 ? (
          <LinkButton href={href(page - 1)} variant="secondary" size="sm">
            Prev
          </LinkButton>
        ) : (
          <span className="inline-flex h-8 items-center px-2 text-[12px] text-muted">Prev</span>
        )}
        <span className="text-[12px] tabular-nums text-ink-2">
          {page}/{totalPages}
        </span>
        {page < totalPages ? (
          <LinkButton href={href(page + 1)} variant="secondary" size="sm">
            Next
          </LinkButton>
        ) : (
          <span className="inline-flex h-8 items-center px-2 text-[12px] text-muted">Next</span>
        )}
      </div>
    </div>
  );
}

async function ReadingPane({
  slug,
  threadId,
  mailboxId,
  listPath,
}: {
  slug: string;
  threadId: string;
  mailboxId: string | null;
  listPath: string;
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
  const { workspace } = await getWorkspaceContext(slug);
  return (
    <ThreadView
      slug={slug}
      detail={result.detail}
      backHref={listPath}
      returnTo={listPath}
      mailboxId={mailboxId}
      aiEnabled={workspace.ai_enabled}
    />
  );
}
