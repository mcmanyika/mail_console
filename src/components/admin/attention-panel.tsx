import { AlertTriangle, CheckCircle2, Gauge, Globe, MailX } from "lucide-react";
import Link from "next/link";
import { Panel, PanelHeader } from "@/components/ui/panel";
import type { AttentionItem } from "@/lib/data/admin";
import { cn } from "@/lib/utils";

const icons = { dns: Globe, limit: Gauge, outbox: MailX };

export function AttentionPanel({ items }: { items: AttentionItem[] }) {
  return (
    <Panel className="h-full">
      <PanelHeader title="Needs attention" description="DNS failures, limits close to being hit, and failed outbound jobs." />
      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
          <CheckCircle2 className="size-6 text-success" aria-hidden />
          <p className="text-sm font-medium text-ink">All clear</p>
          <p className="text-[13px] text-muted">No DNS failures, no workspaces near their limit, no failed jobs.</p>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((item, i) => {
            const Icon = icons[item.kind] ?? AlertTriangle;
            return (
              <li key={`${item.kind}-${item.workspaceId}-${i}`}>
                <Link href={`/admin/workspaces/${item.workspaceId}`} className="flex gap-3 px-5 py-3.5 transition-colors hover:bg-surface-muted">
                  <span
                    className={cn(
                      "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md",
                      item.severity === "danger" ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn",
                    )}
                  >
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink">{item.title}</span>
                    <span className="block truncate text-[13px] text-muted">
                      {item.workspaceName} · {item.detail}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
