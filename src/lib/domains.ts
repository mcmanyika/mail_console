import type { ProviderDomain } from "@/lib/resend/types";
import type { DnsRecord, DomainStatus, InboundDomainStatus, Json } from "@/lib/types/database";

export const HOSTNAME_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeHostname(input: string): string {
  return input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
}

export function asDnsRecords(value: Json): DnsRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((r): r is DnsRecord => !!r && typeof r === "object" && !Array.isArray(r) && "name" in r && "value" in r) as DnsRecord[];
}

/** Inbound readiness depends on the receiving (MX) record; everything else is about sending. */
export function isInboundRecord(r: DnsRecord): boolean {
  return r.record?.toLowerCase() === "receiving" || r.type?.toUpperCase() === "MX";
}

export function splitRecords(records: DnsRecord[]): { outbound: DnsRecord[]; inbound: DnsRecord[] } {
  return { outbound: records.filter((r) => !isInboundRecord(r)), inbound: records.filter(isInboundRecord) };
}

function toStatus(raw: string): DomainStatus {
  switch (raw) {
    case "verified":
    case "failed":
    case "pending":
    case "not_started":
    case "temporary_failure":
    case "partially_verified":
    case "partially_failed":
      return raw;
    default:
      return "pending";
  }
}

/** Map a provider domain onto the two readiness columns stored in `domains`. */
export function statusesFromProvider(p: ProviderDomain): { send: DomainStatus; inbound: InboundDomainStatus } {
  const send = p.status;
  if (!p.receivingEnabled) return { send, inbound: "disabled" };
  const rx = p.records.filter(isInboundRecord);
  if (rx.length === 0) return { send, inbound: send };
  if (rx.every((r) => r.status === "verified")) return { send, inbound: "verified" };
  if (rx.some((r) => r.status === "failed")) return { send, inbound: "failed" };
  if (rx.some((r) => r.status === "temporary_failure")) return { send, inbound: "temporary_failure" };
  return { send, inbound: toStatus(rx[0].status) === "not_started" ? "not_started" : "pending" };
}

export function statusTone(status: string): "success" | "warn" | "danger" | "neutral" {
  if (status === "verified") return "success";
  if (status === "failed" || status === "partially_failed" || status === "temporary_failure") return "danger";
  if (status === "pending" || status === "partially_verified") return "warn";
  return "neutral";
}

export function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
