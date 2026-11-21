import type { AdminClient } from "@/lib/supabase/admin";
import type { DnsRecord, DomainRow, DomainStatus, InboundDomainStatus } from "@/lib/types/database";
import { AuthzError, isPlatformAdmin, requireWorkspaceRole } from "@/lib/auth/authz";
import { ProviderRequestError, type EmailAdapter } from "./adapter";
import type { ProviderDomain } from "./types";

/**
 * Server-side domain service. Domains are created at the provider with BOTH
 * capabilities (sending + receiving), then mirrored in `public.domains`.
 * Everything here uses the service-role client; authorization is performed in
 * `requireDomainManager` BEFORE any provider or DB call.
 *
 * Provider API reference:
 *   https://resend.com/docs/api-reference/domains/create-domain
 *   https://resend.com/docs/api-reference/domains/verify-domain
 */

export class DomainServiceError extends Error {
  constructor(
    readonly code: "invalid_hostname" | "domain_taken" | "not_found" | "provider_error" | "internal",
    message: string,
    readonly status: 400 | 404 | 409 | 502 | 500,
  ) {
    super(message);
    this.name = "DomainServiceError";
  }
}

// ---- hostnames ---------------------------------------------------------------------------
const HOSTNAME_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// Common multi-label public suffixes (not exhaustive — users can always type the exact hostname).
const TWO_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.za", "co.in",
  "com.br", "com.mx", "com.ar", "co.jp", "or.jp", "ne.jp", "com.sg", "com.hk", "com.tr", "com.cn",
]);

export function normalizeHostname(input: string): string {
  const h = input.trim().toLowerCase().replace(/\.$/, "");
  if (!HOSTNAME_RE.test(h) || h.length > 253) {
    throw new DomainServiceError("invalid_hostname", `"${input}" is not a valid domain name`, 400);
  }
  return h;
}

/** Registrable ("apex") domain of a hostname: `app.example.co.uk` -> `example.co.uk`. */
export function apexOf(hostname: string): string {
  const labels = normalizeHostname(hostname).split(".");
  const suffixLen = TWO_LEVEL_SUFFIXES.has(labels.slice(-2).join(".")) ? 3 : 2;
  return labels.slice(-suffixLen).join(".");
}

/** The recommended sending/receiving hostname for an apex: `mail.{apex}` (keeps root-domain MX untouched). */
export function suggestDomainHostname(apexOrHostname: string): string {
  return `mail.${apexOf(apexOrHostname)}`;
}

// ---- status / DNS mapping -------------------------------------------------------------------
const SENDING_RECORDS = new Set(["spf", "dkim"]);
const RECEIVING_RECORDS = new Set(["receiving", "mx"]);

function rollup(statuses: string[], fallback: DomainStatus): DomainStatus {
  if (statuses.length === 0) return fallback;
  const set = new Set(statuses);
  if (set.size === 1) {
    const only = [...set][0];
    if (only === "verified" || only === "pending" || only === "failed" || only === "not_started" || only === "temporary_failure") return only;
  }
  if (set.has("failed")) return set.has("verified") ? "partially_failed" : "failed";
  if (set.has("temporary_failure")) return "temporary_failure";
  if (set.has("verified")) return "partially_verified";
  return fallback;
}

/** Per-capability status derived from the individual DNS records (falls back to the domain status). */
export function deriveCapabilityStatuses(domain: ProviderDomain): { send: DomainStatus; inbound: InboundDomainStatus } {
  const sendStatuses = domain.records.filter((r) => SENDING_RECORDS.has(r.record.toLowerCase())).map((r) => r.status);
  const recvStatuses = domain.records.filter((r) => RECEIVING_RECORDS.has(r.record.toLowerCase())).map((r) => r.status);
  return {
    send: domain.sendingEnabled ? rollup(sendStatuses, domain.status) : "not_started",
    inbound: domain.receivingEnabled ? rollup(recvStatuses, domain.status) : "disabled",
  };
}

export function domainRowFields(domain: ProviderDomain) {
  const { send, inbound } = deriveCapabilityStatuses(domain);
  return {
    resend_domain_id: domain.providerDomainId,
    send_status: send,
    inbound_status: inbound,
    dns_records: domain.records as unknown as DomainRow["dns_records"],
    last_checked_at: new Date().toISOString(),
  };
}

export type MappedDnsRecord = {
  purpose: "sending" | "receiving" | "other";
  type: string;
  /** Name as the provider reports it (relative to the domain; "@" = the domain itself). */
  name: string;
  /** Fully-qualified host to enter at a registrar that wants absolute names. */
  host: string;
  value: string;
  ttl: string;
  priority: number | null;
  status: string;
  label: string;
};

/** Provider records -> UI/API friendly list with FQDN hosts and the capability each belongs to. */
export function mapDnsRecords(hostname: string, records: readonly DnsRecord[]): MappedDnsRecord[] {
  return records.map((r) => {
    const key = r.record.toLowerCase();
    const purpose = SENDING_RECORDS.has(key) ? "sending" : RECEIVING_RECORDS.has(key) ? "receiving" : "other";
    const name = r.name || "@";
    return {
      purpose,
      type: r.type,
      name,
      host: name === "@" ? hostname : `${name}.${hostname}`,
      value: r.value,
      ttl: r.ttl,
      priority: typeof r.priority === "number" ? r.priority : null,
      status: r.status,
      label: r.record,
    };
  });
}

export function dnsRecordsFromRow(row: Pick<DomainRow, "dns_records">): DnsRecord[] {
  return Array.isArray(row.dns_records) ? (row.dns_records as unknown as DnsRecord[]) : [];
}

// ---- authz ---------------------------------------------------------------------------------------
/** Platform admins or workspace owners/admins may manage a workspace's domains. */
export async function requireDomainManager(admin: AdminClient, userId: string, workspaceId: string): Promise<void> {
  if (await isPlatformAdmin(admin, userId)) return;
  await requireWorkspaceRole(admin, userId, workspaceId, "admin");
}

// ---- operations ------------------------------------------------------------------------------------
type Ctx = { admin: AdminClient; adapter: EmailAdapter; userId: string };

function providerFailure(err: unknown): DomainServiceError {
  if (err instanceof ProviderRequestError) {
    return new DomainServiceError("provider_error", `Email provider error: ${err.message}`, err.statusCode === 404 ? 404 : 502);
  }
  return new DomainServiceError("provider_error", "Email provider request failed", 502);
}

async function audit(admin: AdminClient, workspaceId: string, userId: string, action: string, domainId: string, metadata: Record<string, string> = {}) {
  await admin.from("audit_logs").insert({
    workspace_id: workspaceId,
    actor_user_id: userId,
    action,
    resource_type: "domain",
    resource_id: domainId,
    metadata,
  });
}

/**
 * Creates a domain with sending + receiving enabled. If `hostname` is omitted
 * the suggestion `mail.{apex}` is used (from `apex`).
 */
export async function createWorkspaceDomain(
  ctx: Ctx,
  input: { workspaceId: string; hostname?: string; apex?: string },
): Promise<{ domain: DomainRow; dnsRecords: MappedDnsRecord[] }> {
  await requireDomainManager(ctx.admin, ctx.userId, input.workspaceId);

  const raw = input.hostname?.trim() || (input.apex ? suggestDomainHostname(input.apex) : "");
  if (!raw) throw new DomainServiceError("invalid_hostname", "A hostname or apex domain is required", 400);
  const hostname = normalizeHostname(raw);

  const { data: taken, error: takenErr } = await ctx.admin.from("domains").select("id").eq("hostname", hostname).maybeSingle();
  if (takenErr) throw new DomainServiceError("internal", "Domain lookup failed", 500);
  if (taken) throw new DomainServiceError("domain_taken", "This domain is already registered", 409);

  let provider: ProviderDomain;
  try {
    provider = await ctx.adapter.createDomain({ hostname, enableReceiving: true });
  } catch (err) {
    throw providerFailure(err);
  }

  const { data: row, error } = await ctx.admin
    .from("domains")
    .insert({ workspace_id: input.workspaceId, hostname, ...domainRowFields(provider) })
    .select("*")
    .single();
  if (error || !row) {
    // Don't leave an orphan at the provider (best effort).
    await ctx.adapter.deleteDomain(provider.providerDomainId).catch(() => undefined);
    if (error?.code === "23505") throw new DomainServiceError("domain_taken", "This domain is already registered", 409);
    throw new DomainServiceError("internal", "Failed to save domain", 500);
  }
  await audit(ctx.admin, input.workspaceId, ctx.userId, "domain.created", row.id, { hostname });
  return { domain: row, dnsRecords: mapDnsRecords(hostname, provider.records) };
}

async function loadDomain(admin: AdminClient, domainId: string): Promise<DomainRow> {
  const { data, error } = await admin.from("domains").select("*").eq("id", domainId).maybeSingle();
  if (error) throw new DomainServiceError("internal", "Domain lookup failed", 500);
  if (!data) throw new DomainServiceError("not_found", "Domain not found", 404);
  return data;
}

async function persistProviderDomain(admin: AdminClient, row: DomainRow, provider: ProviderDomain): Promise<DomainRow> {
  const { data, error } = await admin
    .from("domains")
    .update(domainRowFields(provider))
    .eq("id", row.id)
    .select("*")
    .single();
  if (error || !data) throw new DomainServiceError("internal", "Failed to update domain", 500);
  return data;
}

/** Ask the provider to (re)check DNS, then mirror the result. Safe to call repeatedly. */
export async function verifyWorkspaceDomain(
  ctx: Ctx,
  input: { domainId: string },
): Promise<{ domain: DomainRow; dnsRecords: MappedDnsRecord[] }> {
  const row = await loadDomain(ctx.admin, input.domainId);
  await requireDomainManager(ctx.admin, ctx.userId, row.workspace_id);
  if (!row.resend_domain_id) throw new DomainServiceError("not_found", "Domain is not registered with the provider", 404);

  let provider: ProviderDomain;
  try {
    provider = await ctx.adapter.verifyDomain(row.resend_domain_id);
  } catch (err) {
    throw providerFailure(err);
  }
  const updated = await persistProviderDomain(ctx.admin, row, provider);
  await audit(ctx.admin, row.workspace_id, ctx.userId, "domain.verify_requested", row.id, {
    send_status: updated.send_status,
    inbound_status: updated.inbound_status,
  });
  return { domain: updated, dnsRecords: mapDnsRecords(updated.hostname, provider.records) };
}

/** Webhook path (`domain.*` events): refresh our mirror from the provider. No user authz — caller is the verified webhook. */
export async function syncDomainFromProvider(
  admin: AdminClient,
  adapter: EmailAdapter,
  providerDomainId: string,
): Promise<"updated" | "unknown_domain"> {
  const { data: row, error } = await admin.from("domains").select("*").eq("resend_domain_id", providerDomainId).maybeSingle();
  if (error) throw new Error(`domain lookup failed: ${error.message}`);
  if (!row) return "unknown_domain";
  const provider = await adapter.getDomain(providerDomainId);
  await persistProviderDomain(admin, row, provider);
  return "updated";
}

/** Read helper for UIs/actions: mapped DNS instructions for a domain the user may manage. */
export async function getWorkspaceDomainDns(
  ctx: Pick<Ctx, "admin" | "userId">,
  input: { domainId: string },
): Promise<{ domain: DomainRow; dnsRecords: MappedDnsRecord[] }> {
  const row = await loadDomain(ctx.admin, input.domainId);
  await requireDomainManager(ctx.admin, ctx.userId, row.workspace_id);
  return { domain: row, dnsRecords: mapDnsRecords(row.hostname, dnsRecordsFromRow(row)) };
}

export { AuthzError };
