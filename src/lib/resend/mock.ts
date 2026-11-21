import { nanoid } from "nanoid";
import type { DnsRecord } from "@/lib/types/database";
import { ProviderRequestError, type EmailAdapter } from "./adapter";
import {
  WebhookVerificationError,
  type CreateDomainInput,
  type DownloadedAttachment,
  type ProviderDomain,
  type ProviderWebhookEvent,
  type ReceivedEmail,
  type SendEmailInput,
  type SendEmailResult,
} from "./types";

export type MockSentEmail = {
  providerEmailId: string;
  idempotencyKey: string;
  input: SendEmailInput;
  sentAt: string;
};

/** Subject markers to exercise the outbox failure paths in demo/tests. */
export const MOCK_FAIL_MARKER = "[mock-fail]"; // permanent failure
export const MOCK_TRANSIENT_MARKER = "[mock-transient]"; // fails once per idempotency key, then succeeds

type MockState = {
  sent: MockSentEmail[];
  byIdempotencyKey: Map<string, string>;
  transientSeen: Set<string>;
  domains: Map<string, ProviderDomain>;
  received: Map<string, ReceivedEmail>;
  attachments: Map<string, DownloadedAttachment>;
};

function createState(): MockState {
  return {
    sent: [],
    byIdempotencyKey: new Map(),
    transientSeen: new Set(),
    domains: new Map(),
    received: new Map(),
    attachments: new Map(),
  };
}

// Survive Next.js dev-server module reloads so the demo "provider" is stable.
const globalKey = Symbol.for("mail-console.mock-email-state");
type GlobalWithState = typeof globalThis & { [globalKey]?: MockState };

function sharedState(): MockState {
  const g = globalThis as GlobalWithState;
  return (g[globalKey] ??= createState());
}

function dnsRecordsFor(hostname: string, status: string, receiving: boolean): DnsRecord[] {
  const records: DnsRecord[] = [
    { record: "SPF", name: "send", type: "TXT", value: "v=spf1 include:mock-ses.example ~all", ttl: "Auto", status },
    { record: "DKIM", name: "resend._domainkey", type: "TXT", value: `p=MOCK_DKIM_KEY_FOR_${hostname}`, ttl: "Auto", status },
  ];
  if (receiving) {
    records.push({ record: "Receiving", name: "@", type: "MX", value: "inbound-smtp.mock.example", ttl: "Auto", status, priority: 10 });
  }
  return records;
}

/**
 * Demo/test adapter. Makes NO network calls and delivers NOTHING: "sent"
 * emails are only recorded in memory (inspect with `getSentEmails()`).
 */
export class MockEmailAdapter implements EmailAdapter {
  readonly mode = "mock" as const;
  private readonly state: MockState;

  /** Pass a private state for isolated unit tests; omit to share process-wide demo state. */
  constructor(state?: MockState) {
    this.state = state ?? sharedState();
  }

  static createIsolated(): MockEmailAdapter {
    return new MockEmailAdapter(createState());
  }

  // ---- inspection helpers (not part of EmailAdapter) ----
  getSentEmails(): readonly MockSentEmail[] {
    return this.state.sent;
  }

  reset(): void {
    const fresh = createState();
    Object.assign(this.state, fresh);
  }

  /** Make an inbound email available to `getReceivedEmail` (simulate an inbound webhook). */
  injectReceivedEmail(email: ReceivedEmail, attachments: Record<string, DownloadedAttachment> = {}): void {
    this.state.received.set(email.providerEmailId, email);
    for (const [id, a] of Object.entries(attachments)) {
      this.state.attachments.set(`${email.providerEmailId}:${id}`, a);
    }
  }

  // ---- EmailAdapter ----
  async sendEmail(input: SendEmailInput, opts: { idempotencyKey: string }): Promise<SendEmailResult> {
    const existing = this.state.byIdempotencyKey.get(opts.idempotencyKey);
    if (existing) return { ok: true, providerEmailId: existing };

    if (input.subject.includes(MOCK_FAIL_MARKER)) {
      return { ok: false, error: { message: "Mock permanent failure", statusCode: 422, retryable: false, code: "validation_error" } };
    }
    if (input.subject.includes(MOCK_TRANSIENT_MARKER) && !this.state.transientSeen.has(opts.idempotencyKey)) {
      this.state.transientSeen.add(opts.idempotencyKey);
      return { ok: false, error: { message: "Mock transient failure", statusCode: 503, retryable: true, code: "application_error" } };
    }
    if (input.to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0) > 50) {
      return { ok: false, error: { message: "Too many recipients (max 50)", statusCode: 422, retryable: false, code: "validation_error" } };
    }

    const providerEmailId = `mock_${nanoid(16)}`;
    this.state.sent.push({ providerEmailId, idempotencyKey: opts.idempotencyKey, input, sentAt: new Date().toISOString() });
    this.state.byIdempotencyKey.set(opts.idempotencyKey, providerEmailId);
    return { ok: true, providerEmailId };
  }

  async createDomain(input: CreateDomainInput): Promise<ProviderDomain> {
    const receiving = input.enableReceiving ?? true;
    const domain: ProviderDomain = {
      providerDomainId: `mock_domain_${nanoid(10)}`,
      hostname: input.hostname,
      status: "pending",
      sendingEnabled: true,
      receivingEnabled: receiving,
      records: dnsRecordsFor(input.hostname, "pending", receiving),
    };
    this.state.domains.set(domain.providerDomainId, domain);
    return domain;
  }

  async getDomain(providerDomainId: string): Promise<ProviderDomain> {
    const d = this.state.domains.get(providerDomainId);
    if (!d) throw new ProviderRequestError("Mock domain not found", 404, false);
    return d;
  }

  async verifyDomain(providerDomainId: string): Promise<ProviderDomain> {
    const d = await this.getDomain(providerDomainId);
    // The mock "DNS" always resolves instantly.
    const verified: ProviderDomain = {
      ...d,
      status: "verified",
      records: dnsRecordsFor(d.hostname, "verified", d.receivingEnabled),
    };
    this.state.domains.set(providerDomainId, verified);
    return verified;
  }

  async deleteDomain(providerDomainId: string): Promise<void> {
    this.state.domains.delete(providerDomainId);
  }

  async getReceivedEmail(providerEmailId: string): Promise<ReceivedEmail> {
    const e = this.state.received.get(providerEmailId);
    if (!e) throw new ProviderRequestError("Mock received email not found", 404, false);
    return e;
  }

  async downloadReceivedAttachment(providerEmailId: string, providerAttachmentId: string): Promise<DownloadedAttachment> {
    const a = this.state.attachments.get(`${providerEmailId}:${providerAttachmentId}`);
    if (!a) throw new ProviderRequestError("Mock attachment not found", 404, false);
    return a;
  }

  /** Demo mode accepts unsigned JSON (there is no real provider to impersonate). */
  verifyWebhook(rawBody: string, headers: Headers): ProviderWebhookEvent {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new WebhookVerificationError("Malformed JSON body");
    }
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
      throw new WebhookVerificationError("Malformed webhook payload");
    }
    const raw = parsed as Record<string, unknown>;
    const eventId = headers.get("svix-id") ?? (typeof raw.id === "string" ? raw.id : `mock_evt_${nanoid(12)}`);
    return {
      eventId,
      type: raw.type as string,
      createdAt: typeof raw.created_at === "string" ? raw.created_at : new Date().toISOString(),
      data: (raw.data && typeof raw.data === "object" ? raw.data : {}) as Record<string, unknown>,
      raw,
    };
  }
}
