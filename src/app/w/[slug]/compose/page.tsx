import type { Metadata } from "next";
import { Lock, SearchX } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { ComposeForm } from "@/components/inbox/compose-form";
import { LinkButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { loadCompose } from "@/lib/data/compose";
import { first } from "@/lib/format";
import { inboxHref } from "@/lib/inbox-links";

export const metadata: Metadata = { title: "Compose" };

type Params = Promise<{ slug: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;

export default function ComposePage({ params, searchParams }: { params: Params; searchParams: SP }) {
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col p-0 md:p-6">
      <Suspense
        fallback={
          <div className="flex-1 rounded-lg border border-line bg-surface p-6">
            <Skeleton className="mb-6 h-7 w-40" />
            <Skeleton className="mb-3 h-9 w-full" />
            <Skeleton className="mb-3 h-9 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        }
      >
        <ComposeBody params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function ComposeBody({ params, searchParams }: { params: Params; searchParams: SP }) {
  await connection();
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const back = inboxHref(slug, { folder: "inbox" });
  const result = await loadCompose(slug, {
    mode: first(sp.mode),
    message: first(sp.message),
    draft: first(sp.draft),
    mailbox: first(sp.mailbox),
  });

  if (result.status === "no_send_access") {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <EmptyState
          icon={Lock}
          title="You can't send from any mailbox yet"
          description="Sending needs a “read & send” grant on a mailbox — owners and admins don't get one automatically."
          action={<LinkButton href={back} variant="secondary">Back to inbox</LinkButton>}
        />
      </div>
    );
  }
  if (result.status === "denied") {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <EmptyState icon={Lock} title="Can't compose here" description={result.message} action={<LinkButton href={back} variant="secondary">Back to inbox</LinkButton>} />
      </div>
    );
  }
  if (result.status === "not_found") {
    return (
      <div className="rounded-lg border border-line bg-surface">
        <EmptyState icon={SearchX} title="Message not found" description="It may have been sent, deleted, or you may not have access." action={<LinkButton href={back} variant="secondary">Back to inbox</LinkButton>} />
      </div>
    );
  }

  const { init } = result;
  return (
    <section
      aria-label={init.heading}
      className="flex min-h-0 flex-1 flex-col overflow-hidden border-line bg-surface shadow-(--shadow-panel) md:rounded-lg md:border"
    >
      <header className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3.5 md:px-6">
        <h1 className="font-serif text-xl font-semibold text-ink">{init.heading}</h1>
        <Link href={back} className="text-[13px] text-muted hover:text-ink">
          Back to inbox
        </Link>
      </header>
      <ComposeForm init={init} backHref={back} />
    </section>
  );
}
