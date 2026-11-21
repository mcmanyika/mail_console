import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/ui/copy-button";
import { asDnsRecords, splitRecords, statusLabel, statusTone } from "@/lib/domains";
import { formatRelative } from "@/lib/format";
import type { DnsRecord, DomainRow } from "@/lib/types/database";
import { RecheckButton } from "./domain-forms";

function RecordsTable({ records, empty }: { records: DnsRecord[]; empty: string }) {
  if (records.length === 0) return <p className="px-4 py-3 text-[13px] text-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-[13px]">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-muted">
            <th className="px-4 py-2 font-medium">Type</th>
            <th className="px-2 py-2 font-medium">Name</th>
            <th className="px-2 py-2 font-medium">Value</th>
            <th className="px-2 py-2 font-medium">TTL</th>
            <th className="px-4 py-2 text-right font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {records.map((r, i) => (
            <tr key={`${r.record}-${r.name}-${i}`} className="align-top">
              <td className="px-4 py-2.5">
                <span className="font-mono text-xs font-medium text-ink">{r.type}</span>
                <div className="text-[11px] text-muted">{r.record}</div>
              </td>
              <td className="px-2 py-2.5">
                <div className="flex items-start gap-1.5">
                  <code className="break-all font-mono text-xs text-ink-2">{r.name}</code>
                  <CopyButton value={r.name} iconOnly className="shrink-0 px-1.5" />
                </div>
              </td>
              <td className="px-2 py-2.5">
                <div className="flex items-start gap-1.5">
                  <code className="max-w-[26rem] break-all font-mono text-xs text-ink-2">
                    {r.priority != null ? `${r.priority} ` : ""}
                    {r.value}
                  </code>
                  <CopyButton value={r.value} iconOnly className="shrink-0 px-1.5" />
                </div>
              </td>
              <td className="px-2 py-2.5 text-xs text-muted">{r.ttl}</td>
              <td className="px-4 py-2.5 text-right">
                <Badge tone={statusTone(r.status)} dot>
                  {statusLabel(r.status)}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DomainCard({ domain, canManage = true }: { domain: DomainRow; canManage?: boolean }) {
  const { outbound, inbound } = splitRecords(asDnsRecords(domain.dns_records));
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-surface shadow-(--shadow-panel)" aria-label={domain.hostname}>
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-5 py-4">
        <div>
          <h3 className="font-mono text-[15px] font-medium text-ink">{domain.hostname}</h3>
          <p className="mt-0.5 text-xs text-muted">Last checked {formatRelative(domain.last_checked_at)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-2">
            <Badge tone={statusTone(domain.send_status)} dot>
              <ArrowUpFromLine className="size-3" aria-hidden /> Sending · {statusLabel(domain.send_status)}
            </Badge>
            <Badge tone={domain.inbound_status === "disabled" ? "neutral" : statusTone(domain.inbound_status)} dot>
              <ArrowDownToLine className="size-3" aria-hidden /> Receiving · {statusLabel(domain.inbound_status)}
            </Badge>
          </div>
          {canManage ? <RecheckButton domainId={domain.id} /> : null}
        </div>
      </header>
      <div className="divide-y divide-line">
        <div>
          <div className="flex items-center gap-2 bg-surface-muted px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-2">
            <ArrowUpFromLine className="size-3.5" aria-hidden /> Outbound — required to send mail
          </div>
          <RecordsTable records={outbound} empty="No outbound records reported yet." />
        </div>
        <div>
          <div className="flex items-center gap-2 bg-surface-muted px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-2">
            <ArrowDownToLine className="size-3.5" aria-hidden /> Inbound — required to receive mail
          </div>
          <RecordsTable
            records={inbound}
            empty={domain.inbound_status === "disabled" ? "Receiving is disabled for this domain." : "No inbound records reported yet."}
          />
        </div>
      </div>
      <footer className="border-t border-line bg-surface-muted/60 px-5 py-2.5 text-xs text-muted">
        DNS changes can take up to 48 hours to propagate. Sending and receiving are verified independently — you can send
        before inbound is ready.
      </footer>
    </section>
  );
}
