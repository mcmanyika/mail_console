import { PauseCircle, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { getCurrentProfile, getIsPlatformAdmin } from "@/lib/auth/session";
import { getDraftCount, getUnreadCounts } from "@/lib/data/inbox";
import { getWorkspaceContext } from "@/lib/data/workspace";
import { Brand } from "./brand";
import { UserMenu } from "./user-menu";
import { WorkspaceRail } from "./workspace-rail";
import { WorkspaceSwitcher } from "./workspace-switcher";

export function ShellSkeleton() {
  return (
    <div className="flex h-dvh flex-col">
      <div className="h-14 border-b border-line bg-surface" />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="hidden w-56 border-r border-line bg-surface p-3 md:block">
          <Skeleton className="mb-3 h-10 w-full" />
          <Skeleton className="mb-2 h-8 w-full" />
          <Skeleton className="mb-2 h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
        <div className="flex-1 p-6">
          <Skeleton className="h-8 w-48" />
        </div>
      </div>
    </div>
  );
}

export async function WorkspaceShell({ slug, children }: { slug: string; children: React.ReactNode }) {
  const ctx = await getWorkspaceContext(slug);
  const [profile, isPlatform] = await Promise.all([getCurrentProfile(), getIsPlatformAdmin()]);
  const countsPromise = Promise.all([getUnreadCounts(slug), getDraftCount(slug)]).then(([u, drafts]) => ({
    unread: u.total,
    drafts,
  }));
  const suspended = ctx.workspace.status === "suspended";

  return (
    <div className="flex h-dvh flex-col bg-canvas">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 md:px-4">
        <Brand href={`/w/${slug}/inbox`} compact className="shrink-0" />
        <span className="hidden h-5 w-px bg-line sm:block" />
        <Suspense fallback={<span className="px-2.5 text-sm font-medium text-ink">{ctx.workspace.name}</span>}>
          <WorkspaceSwitcher currentSlug={slug} currentName={ctx.workspace.name} />
        </Suspense>
        <div className="ml-auto flex items-center gap-3">
          {isPlatform ? (
            <Link href="/admin" className="hidden items-center gap-1.5 text-[13px] text-muted hover:text-ink sm:flex">
              <ShieldCheck className="size-3.5" aria-hidden /> Admin
            </Link>
          ) : null}
          <UserMenu email={ctx.user.email ?? ""} name={profile?.full_name} />
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="shrink-0 border-b border-line bg-surface md:w-56 md:border-b-0 md:border-r">
          <WorkspaceRail slug={slug} countsPromise={countsPromise} />
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          {suspended ? (
            <div className="shrink-0 px-4 pt-4">
              <Alert tone="warn" title="This workspace is suspended">
                <PauseCircle className="mr-1 inline size-3.5 align-text-bottom" aria-hidden />
                Sending and the transactional API are paused. Incoming mail is still received and you can read it.
              </Alert>
            </div>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  );
}
