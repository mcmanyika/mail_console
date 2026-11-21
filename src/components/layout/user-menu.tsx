import { LogOut } from "lucide-react";
import { signOutAction } from "@/lib/actions/auth";
import { initials } from "@/lib/format";

export function UserMenu({ email, name }: { email: string; name?: string | null }) {
  return (
    <details className="group relative">
      <summary
        className="flex size-8 cursor-pointer list-none items-center justify-center rounded-full bg-ink text-[11px] font-semibold text-white [&::-webkit-details-marker]:hidden"
        aria-label="Account menu"
      >
        {initials(name || email)}
      </summary>
      <div className="absolute right-0 z-30 mt-2 w-60 rounded-lg border border-line bg-surface p-1 shadow-(--shadow-pop)">
        <div className="border-b border-line px-3 py-2">
          {name ? <p className="truncate text-sm font-medium text-ink">{name}</p> : null}
          <p className="truncate text-xs text-muted">{email}</p>
        </div>
        <form action={signOutAction}>
          <button
            type="submit"
            className="mt-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-ink-2 hover:bg-canvas-deep"
          >
            <LogOut className="size-4" aria-hidden /> Sign out
          </button>
        </form>
      </div>
    </details>
  );
}
