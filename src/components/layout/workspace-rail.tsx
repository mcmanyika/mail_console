"use client";

import { Archive, FileText, Inbox, Megaphone, PenSquare, Send, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, use } from "react";
import { cn } from "@/lib/utils";

type Counts = { unread: number; drafts: number };

function RailLinks({ slug, counts }: { slug: string; counts: Counts | null }) {
  const pathname = usePathname();
  const sp = useSearchParams();
  const folder = sp.get("folder") ?? "inbox";
  const mailbox = sp.get("mailbox");
  const onInbox = pathname === `/w/${slug}/inbox`;
  const mailboxQs = mailbox ? `&mailbox=${encodeURIComponent(mailbox)}` : "";

  const items = [
    { key: "inbox", label: "Inbox", icon: Inbox, href: `/w/${slug}/inbox?folder=inbox${mailboxQs}`, active: onInbox && folder === "inbox", badge: counts?.unread },
    { key: "sent", label: "Sent", icon: Send, href: `/w/${slug}/inbox?folder=sent${mailboxQs}`, active: onInbox && folder === "sent" },
    { key: "drafts", label: "Drafts", icon: FileText, href: `/w/${slug}/inbox?folder=drafts${mailboxQs}`, active: onInbox && folder === "drafts", badge: counts?.drafts, quiet: true },
    { key: "archive", label: "Archive", icon: Archive, href: `/w/${slug}/inbox?folder=archive${mailboxQs}`, active: onInbox && folder === "archive" },
  ];
  const settingsActive = pathname.startsWith(`/w/${slug}/settings`);
  const campaignsActive = pathname.startsWith(`/w/${slug}/campaigns`);

  return (
    <nav aria-label="Mail" className="flex gap-1 overflow-x-auto p-2 md:flex-col md:overflow-visible md:p-3">
      <Link
        href={`/w/${slug}/compose${mailbox ? `?mailbox=${encodeURIComponent(mailbox)}` : ""}`}
        className={cn(
          "mr-1 flex shrink-0 items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-hover md:mb-3 md:mr-0 md:py-2.5",
          pathname === `/w/${slug}/compose` && "ring-2 ring-accent/30 ring-offset-2",
        )}
      >
        <PenSquare className="size-4" aria-hidden /> Compose
      </Link>
      {items.map((it) => (
        <Link
          key={it.key}
          href={it.href}
          aria-current={it.active ? "page" : undefined}
          className={cn(
            "flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
            it.active ? "bg-accent-soft font-semibold text-accent-ink" : "text-ink-2 hover:bg-canvas-deep",
          )}
        >
          <it.icon className="size-4 shrink-0" aria-hidden />
          <span className="flex-1">{it.label}</span>
          {it.badge ? (
            <span
              className={cn(
                "rounded-full px-1.5 text-xs font-semibold tabular-nums",
                it.quiet ? "text-muted" : "bg-accent text-white",
              )}
              aria-label={it.quiet ? `${it.badge} drafts` : `${it.badge} unread`}
            >
              {it.badge}
            </span>
          ) : null}
        </Link>
      ))}
      <div className="mx-2 my-2 hidden border-t border-line md:block" />
      <Link
        href={`/w/${slug}/campaigns`}
        aria-current={campaignsActive ? "page" : undefined}
        className={cn(
          "flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
          campaignsActive ? "bg-accent-soft font-semibold text-accent-ink" : "text-ink-2 hover:bg-canvas-deep",
        )}
      >
        <Megaphone className="size-4" aria-hidden /> Campaigns
      </Link>
      <Link
        href={`/w/${slug}/settings`}
        aria-current={settingsActive ? "page" : undefined}
        className={cn(
          "flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
          settingsActive ? "bg-accent-soft font-semibold text-accent-ink" : "text-ink-2 hover:bg-canvas-deep",
        )}
      >
        <Settings className="size-4" aria-hidden /> Settings
      </Link>
    </nav>
  );
}

function RailWithCounts({ slug, countsPromise }: { slug: string; countsPromise: Promise<Counts> }) {
  const counts = use(countsPromise);
  return <RailLinks slug={slug} counts={counts} />;
}

export function WorkspaceRail({ slug, countsPromise }: { slug: string; countsPromise: Promise<Counts> }) {
  return (
    <Suspense fallback={<RailLinks slug={slug} counts={null} />}>
      <RailWithCounts slug={slug} countsPromise={countsPromise} />
    </Suspense>
  );
}
