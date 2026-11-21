import { Check, ChevronsUpDown } from "lucide-react";
import Link from "next/link";
import { getUserWorkspaces } from "@/lib/auth/session";
import { one } from "@/lib/format";
import { cn } from "@/lib/utils";

export async function WorkspaceSwitcher({ currentSlug, currentName }: { currentSlug: string; currentName: string }) {
  const memberships = await getUserWorkspaces();
  const list = memberships
    .map((m) => ({ role: m.role, ws: one(m.workspace as unknown as { id: string; name: string; slug: string; status: string } | null) }))
    .filter((m) => m.ws)
    .sort((a, b) => a.ws!.name.localeCompare(b.ws!.name));
  return (
    <details className="group relative">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md border border-transparent px-2.5 py-1.5 text-sm font-medium text-ink hover:border-line hover:bg-canvas-deep [&::-webkit-details-marker]:hidden">
        <span className="max-w-[10rem] truncate sm:max-w-[16rem]">{currentName}</span>
        <ChevronsUpDown className="size-3.5 text-muted" aria-hidden />
      </summary>
      <div className="absolute left-0 z-30 mt-1.5 w-72 rounded-lg border border-line bg-surface p-1 shadow-(--shadow-pop)">
        <p className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted">Workspaces</p>
        <ul>
          {list.map(({ ws, role }) => (
            <li key={ws!.id}>
              <Link
                href={`/w/${ws!.slug}/inbox`}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm hover:bg-canvas-deep",
                  ws!.slug === currentSlug && "bg-accent-soft/60",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink">{ws!.name}</span>
                  <span className="block text-xs capitalize text-muted">
                    {role}
                    {ws!.status !== "active" ? ` · ${ws!.status}` : ""}
                  </span>
                </span>
                {ws!.slug === currentSlug ? <Check className="size-4 text-accent" aria-hidden /> : null}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
