import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthzError } from "@/lib/auth/authz";
import { seedWorld, type World } from "@/lib/testing/world";
import { MockEmailAdapter } from "./mock";
import {
  apexOf,
  createWorkspaceDomain,
  deriveCapabilityStatuses,
  getWorkspaceDomainDns,
  mapDnsRecords,
  normalizeHostname,
  suggestDomainHostname,
  syncDomainFromProvider,
  verifyWorkspaceDomain,
} from "./domains";

let w: World;
let adapter: MockEmailAdapter;
const owner = () => ({ admin: w.admin, adapter, userId: w.users.noGrant }); // owner of workspace A
beforeEach(() => {
  w = seedWorld();
  adapter = MockEmailAdapter.createIsolated();
});

describe("hostnames", () => {
  it("suggests mail.{apex}", () => {
    expect(suggestDomainHostname("example.com")).toBe("mail.example.com");
    expect(suggestDomainHostname("www.shop.example.com")).toBe("mail.example.com");
    expect(suggestDomainHostname("example.co.uk")).toBe("mail.example.co.uk");
    expect(apexOf("a.b.example.co.uk")).toBe("example.co.uk");
  });
  it("normalises and rejects bad hostnames", () => {
    expect(normalizeHostname("  Mail.Example.COM. ")).toBe("mail.example.com");
    for (const bad of ["", "localhost", "-bad.example.com", "a..b.com", "http://x.com", "x.com/path", "1.2.3.4"]) {
      expect(() => normalizeHostname(bad)).toThrow();
    }
  });
});

describe("createWorkspaceDomain", () => {
  it("creates with sending + receiving, defaults to mail.{apex}, stores DNS records", async () => {
    const { domain, dnsRecords } = await createWorkspaceDomain(owner(), { workspaceId: w.ids.wsA, apex: "newco.example" });
    expect(domain).toMatchObject({ workspace_id: w.ids.wsA, hostname: "mail.newco.example", send_status: "pending", inbound_status: "pending" });
    expect(domain.resend_domain_id).toMatch(/^mock_domain_/);
    expect(dnsRecords.map((r) => `${r.purpose}:${r.type}:${r.host}`)).toEqual([
      "sending:TXT:send.mail.newco.example",
      "sending:TXT:resend._domainkey.mail.newco.example",
      "receiving:MX:mail.newco.example",
    ]);
    expect(dnsRecords.find((r) => r.type === "MX")?.priority).toBe(10);
    expect(w.db.rows("audit_logs")[0]).toMatchObject({ action: "domain.created", workspace_id: w.ids.wsA });
  });

  it("accepts an explicit hostname", async () => {
    const { domain } = await createWorkspaceDomain(owner(), { workspaceId: w.ids.wsA, hostname: "Inbox.Newco.Example" });
    expect(domain.hostname).toBe("inbox.newco.example");
  });

  it("only workspace admins/owners or platform admins may create; others fail before any provider call", async () => {
    const spy = vi.spyOn(adapter, "createDomain");
    await expect(createWorkspaceDomain({ admin: w.admin, adapter, userId: w.users.sender /* member */ }, { workspaceId: w.ids.wsA, apex: "x.example" })).rejects.toBeInstanceOf(AuthzError);
    await expect(createWorkspaceDomain({ admin: w.admin, adapter, userId: w.users.outsider }, { workspaceId: w.ids.wsA, apex: "x.example" })).rejects.toMatchObject({ status: 404 });
    expect(spy).not.toHaveBeenCalled();
    await expect(createWorkspaceDomain({ admin: w.admin, adapter, userId: w.users.platformAdmin }, { workspaceId: w.ids.wsA, apex: "viaadmin.example" })).resolves.toBeTruthy();
  });

  it("rejects duplicates (409) and cleans up the provider on DB failure", async () => {
    await expect(createWorkspaceDomain(owner(), { workspaceId: w.ids.wsA, hostname: "a.example" })).rejects.toMatchObject({ code: "domain_taken", status: 409 });
    // hostnames are globally unique: another tenant (here via a platform admin) can't take it either
    await expect(createWorkspaceDomain({ admin: w.admin, adapter, userId: w.users.platformAdmin }, { workspaceId: w.ids.wsB, hostname: "a.example" })).rejects.toMatchObject({ code: "domain_taken" });
    // and an owner of A can't create domains in B at all
    await expect(createWorkspaceDomain(owner(), { workspaceId: w.ids.wsB, hostname: "zzz.example" })).rejects.toMatchObject({ status: 404 });
    await expect(createWorkspaceDomain(owner(), { workspaceId: w.ids.wsA })).rejects.toMatchObject({ code: "invalid_hostname" });

    const del = vi.spyOn(adapter, "deleteDomain");
    vi.spyOn(w.admin, "from").mockImplementation(((table: string) => {
      const real = (w.db.client() as unknown as { from: (t: string) => unknown }).from(table) as { insert: (...a: unknown[]) => unknown };
      if (table === "domains") {
        return {
          select: (...a: unknown[]) => (real as unknown as { select: (...x: unknown[]) => unknown }).select(...a),
          insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: "XX000", message: "boom" } }) }) }),
        };
      }
      return real;
    }) as never);
    await expect(createWorkspaceDomain(owner(), { workspaceId: w.ids.wsA, hostname: "fresh.example" })).rejects.toMatchObject({ code: "internal" });
    expect(del).toHaveBeenCalledOnce();
  });

  it("maps provider failures to 502", async () => {
    vi.spyOn(adapter, "createDomain").mockRejectedValue(new Error("network"));
    await expect(createWorkspaceDomain(owner(), { workspaceId: w.ids.wsA, hostname: "x.example" })).rejects.toMatchObject({ code: "provider_error", status: 502 });
  });
});

describe("verify / recheck", () => {
  it("rechecks DNS via the provider and mirrors statuses; idempotent", async () => {
    const { domain } = await createWorkspaceDomain(owner(), { workspaceId: w.ids.wsA, apex: "verifyme.example" });
    const r1 = await verifyWorkspaceDomain(owner(), { domainId: domain.id });
    expect(r1.domain).toMatchObject({ send_status: "verified", inbound_status: "verified" });
    expect(r1.domain.last_checked_at).toBeTruthy();
    expect(r1.dnsRecords.every((r) => r.status === "verified")).toBe(true);
    const r2 = await verifyWorkspaceDomain(owner(), { domainId: domain.id });
    expect(r2.domain.send_status).toBe("verified");
  });

  it("is authorised against the DOMAIN's workspace", async () => {
    const domainB = w.db.seed("domains", { workspace_id: w.ids.wsB, hostname: "other.example", resend_domain_id: "x" });
    await expect(verifyWorkspaceDomain(owner(), { domainId: domainB.id as string })).rejects.toMatchObject({ status: 404 });
    await expect(getWorkspaceDomainDns({ admin: w.admin, userId: w.users.sender }, { domainId: w.ids.domA })).rejects.toBeInstanceOf(AuthzError);
    await expect(verifyWorkspaceDomain(owner(), { domainId: "00000000-0000-4000-8000-0000000000ff" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("webhook sync refreshes a known domain and ignores unknown ones", async () => {
    const { domain } = await createWorkspaceDomain(owner(), { workspaceId: w.ids.wsA, apex: "sync.example" });
    await adapter.verifyDomain(domain.resend_domain_id!);
    expect(await syncDomainFromProvider(w.admin, adapter, domain.resend_domain_id!)).toBe("updated");
    expect(w.db.rows("domains").find((d) => d.id === domain.id)).toMatchObject({ send_status: "verified" });
    expect(await syncDomainFromProvider(w.admin, adapter, "nope")).toBe("unknown_domain");
  });
});

describe("status derivation / DNS mapping", () => {
  const rec = (record: string, status: string, type = "TXT", name = "x") => ({ record, name, type, value: "v", ttl: "Auto", status });
  const base = { providerDomainId: "d", hostname: "h.example", sendingEnabled: true, receivingEnabled: true };

  it("rolls records up per capability", () => {
    expect(deriveCapabilityStatuses({ ...base, status: "pending", records: [rec("SPF", "verified"), rec("DKIM", "verified"), rec("Receiving", "pending", "MX")] })).toEqual({ send: "verified", inbound: "pending" });
    expect(deriveCapabilityStatuses({ ...base, status: "pending", records: [rec("SPF", "verified"), rec("DKIM", "failed")] }).send).toBe("partially_failed");
    expect(deriveCapabilityStatuses({ ...base, status: "pending", records: [rec("SPF", "verified"), rec("DKIM", "pending")] }).send).toBe("partially_verified");
    expect(deriveCapabilityStatuses({ ...base, receivingEnabled: false, status: "verified", records: [] })).toEqual({ send: "verified", inbound: "disabled" });
  });

  it("builds fully-qualified hosts", () => {
    const m = mapDnsRecords("mail.example.com", [rec("Receiving", "pending", "MX", "@"), rec("SPF", "pending", "TXT", "send")]);
    expect(m.map((r) => r.host)).toEqual(["mail.example.com", "send.mail.example.com"]);
  });
});
