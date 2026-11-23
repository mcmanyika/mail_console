import { ArrowLeft, Plus, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { Brand } from "@/components/layout/brand";
import { UserMenu } from "@/components/layout/user-menu";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";

export function AdminShell({
  email,
  name,
  children,
}: {
  email: string;
  name?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-4 px-5">
          <Brand href="/admin" />
          <Badge tone="accent" className="hidden sm:inline-flex">
            <ShieldCheck className="size-3" aria-hidden /> Platform admin
          </Badge>
          <nav className="ml-2 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-sm sm:ml-4 sm:gap-1" aria-label="Admin">
            <Link href="/admin" className="shrink-0 rounded-md px-2.5 py-1.5 font-medium text-ink-2 hover:bg-canvas-deep sm:px-3">
              Overview
            </Link>
            <Link href="/admin/users" className="shrink-0 rounded-md px-2.5 py-1.5 font-medium text-ink-2 hover:bg-canvas-deep sm:px-3">
              Users
            </Link>
            <Link href="/admin/new" className="hidden shrink-0 rounded-md px-3 py-1.5 font-medium text-ink-2 hover:bg-canvas-deep sm:inline">
              Add client
            </Link>
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <LinkButton href="/admin/users" variant="secondary" size="sm" className="hidden sm:inline-flex">
              Users
            </LinkButton>
            <LinkButton href="/admin/new" variant="primary" size="sm" className="hidden sm:inline-flex">
              <Plus className="size-4" aria-hidden /> Add client
            </LinkButton>
            <Link href="/dashboard" className="hidden items-center gap-1.5 px-2 text-[13px] text-muted hover:text-ink lg:flex">
              <ArrowLeft className="size-3.5" aria-hidden /> My workspaces
            </Link>
            <UserMenu email={email} name={name} />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1280px] px-5 py-8">{children}</main>
    </div>
  );
}
