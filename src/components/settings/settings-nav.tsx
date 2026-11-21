"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export type NavItem = { key: string; label: string };

/** Client only for active-link styling. The list is already filtered by role on the server. */
export function SettingsNav({ slug, items }: { slug: string; items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
      {items.map((it) => {
        const href = `/w/${slug}/settings/${it.key}`;
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={it.key}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 rounded-md px-3 py-2 text-sm transition-colors",
              active ? "bg-surface font-semibold text-ink shadow-(--shadow-panel) ring-1 ring-line" : "text-ink-2 hover:bg-canvas-deep",
            )}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
