import { Search } from "lucide-react";
import Link from "next/link";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button, LinkButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Select } from "@/components/ui/form-controls";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { UsageBar } from "@/components/ui/usage-bar";
import type { AdminWorkspaceRow, Verification } from "@/lib/data/admin";
import { formatNumber } from "@/lib/format";

const verificationUi: Record<Verification, { label: string; tone: Tone }> = {
  none: { label: "No domain", tone: "neutral" },
  verified: { label: "Verified", tone: "success" },
  pending: { label: "Pending DNS", tone: "warn" },
  failing: { label: "DNS failing", tone: "danger" },
};
const statusTone: Record<string, Tone> = { active: "success", suspended: "danger", pending: "warn" };

export function WorkspaceTable({
  rows,
  q,
  status,
  totalCount,
}: {
  rows: AdminWorkspaceRow[];
  q: string;
  status: string;
  totalCount: number;
}) {
  const filtered = q || (status && status !== "all");
  return (
    <Panel id="workspaces">
      <PanelHeader
        title="Workspaces"
        description={`${rows.length} of ${totalCount} shown`}
        actions={
          <LinkButton href="/admin/new" size="sm" variant="secondary">
            Add client
          </LinkButton>
        }
      />
      <form method="get" action="/admin#workspaces" className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-2" aria-hidden />
          <Input name="q" defaultValue={q} placeholder="Search name, slug or domain" className="pl-9" aria-label="Search workspaces" />
        </div>
        <Select name="status" defaultValue={status || "all"} className="w-40" aria-label="Filter by status">
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="pending">Pending</option>
        </Select>
        <Button type="submit" variant="secondary">
          Apply
        </Button>
        {filtered ? (
          <Link href="/admin#workspaces" className="text-[13px] text-muted hover:text-ink">
            Clear
          </Link>
        ) : null}
      </form>

      {rows.length === 0 ? (
        <EmptyState
          title={filtered ? "No workspaces match" : "No workspaces yet"}
          description={filtered ? "Try a different search or status." : "Add your first client to create a workspace and invite its owner."}
          action={!filtered ? <LinkButton href="/admin/new" variant="primary">Add client</LinkButton> : undefined}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs font-medium uppercase tracking-wide text-muted">
                <th className="px-5 py-2.5 font-medium">Workspace</th>
                <th className="px-3 py-2.5 font-medium">Domains</th>
                <th className="px-3 py-2.5 font-medium">Verification</th>
                <th className="w-56 px-3 py-2.5 font-medium">Usage this month</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-5 py-2.5 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((w) => {
                const v = verificationUi[w.verification];
                return (
                  <tr key={w.id} className="align-middle hover:bg-surface-muted/60">
                    <td className="px-5 py-3.5">
                      <Link href={`/admin/workspaces/${w.id}`} className="font-medium text-ink hover:text-accent">
                        {w.name}
                      </Link>
                      <div className="font-mono text-xs text-muted">{w.slug}</div>
                    </td>
                    <td className="px-3 py-3.5">
                      {w.domains.length === 0 ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <ul className="space-y-0.5">
                          {w.domains.slice(0, 2).map((d) => (
                            <li key={d.id} className="font-mono text-xs text-ink-2">
                              {d.hostname}
                            </li>
                          ))}
                          {w.domains.length > 2 ? <li className="text-xs text-muted">+{w.domains.length - 2} more</li> : null}
                        </ul>
                      )}
                    </td>
                    <td className="px-3 py-3.5">
                      <Badge tone={v.tone} dot>
                        {v.label}
                      </Badge>
                    </td>
                    <td className="px-3 py-3.5">
                      <div className="mb-1.5 flex justify-between text-xs tabular-nums text-ink-2">
                        <span>{formatNumber(w.used)}</span>
                        <span className="text-muted">of {formatNumber(w.limit)}</span>
                      </div>
                      <UsageBar used={w.used} limit={w.limit} label={`${w.name} usage`} />
                    </td>
                    <td className="px-3 py-3.5">
                      <Badge tone={statusTone[w.status] ?? "neutral"}>{w.status}</Badge>
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <LinkButton href={`/admin/workspaces/${w.id}`} size="sm" variant="secondary">
                        Manage
                      </LinkButton>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
