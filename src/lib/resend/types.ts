import type { DnsRecord } from "@/lib/types/database";

export type EmailAdapterMode = "mock" | "live";

// ---- sending -----------------------------------------------------------------
export type OutboundAttachment = {
  filename: string;
  contentType?: string;
  /** Raw bytes (the adapter handles encoding). */
  content: Uint8Array;
  /** Content-ID for inline images (`cid:` references in html). */
  contentId?: string;
};

export type SendEmailInput = {
  /** "Display Name <addr@host>" or bare address. */
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject: string;
  text?: string;
  html?: string;
  /** Extra headers: Message-ID, In-Reply-To, References, ... */
  headers?: Record<string, string>;
  attachments?: OutboundAttachment[];
  tags?: { name: string; value: string }[];
};

export type SendEmailResult =
  | { ok: true; providerEmailId: string }
  | { ok: false; error: ProviderError };

/** Normalised provider failure, classified so the outbox knows whether to retry. */
export type ProviderError = {
  message: string;
  statusCode: number | null;
  /** True for transient failures (network, 429, 5xx) — safe to retry with the same idempotency key. */
  retryable: boolean;
  code?: string;
};

// ---- domains -----------------------------------------------------------------
export type ProviderDomainStatus =
  | "not_started"
  | "pending"
  | "verified"
  | "partially_verified"
  | "partially_failed"
  | "failed"
  | "temporary_failure";

export type ProviderDomain = {
  providerDomainId: string;
  hostname: string;
  status: ProviderDomainStatus;
  sendingEnabled: boolean;
  receivingEnabled: boolean;
  records: DnsRecord[];
};

export type CreateDomainInput = {
  hostname: string;
  region?: "us-east-1" | "eu-west-1" | "sa-east-1" | "ap-northeast-1";
  enableReceiving?: boolean;
};

// ---- inbound -----------------------------------------------------------------
export type ReceivedAttachmentMeta = {
  providerAttachmentId: string;
  filename: string | null;
  contentType: string;
  size: number;
  contentId: string | null;
  disposition: string | null;
};

export type ReceivedEmail = {
  providerEmailId: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  text: string | null;
  html: string | null;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  messageId: string | null;
  receivedAt: string;
  attachments: ReceivedAttachmentMeta[];
};

export type DownloadedAttachment = {
  filename: string;
  contentType: string;
  data: Uint8Array;
};

// ---- webhooks ----------------------------------------------------------------
export type EmailEventType =
  | "email.sent"
  | "email.delivered"
  | "email.delivery_delayed"
  | "email.bounced"
  | "email.complained"
  | "email.failed"
  | "email.suppressed"
  | "email.received";

export type DomainEventType = "domain.created" | "domain.updated" | "domain.deleted";

export type ProviderWebhookEvent = {
  /** Unique, stable delivery id (svix-id) used for idempotent processing. */
  eventId: string;
  type: EmailEventType | DomainEventType | (string & {});
  createdAt: string;
  /** Raw event `data` object from the provider. */
  data: Record<string, unknown>;
  /** Full verified payload (stored in webhook_events.payload). */
  raw: Record<string, unknown>;
};

export class WebhookVerificationError extends Error {
  constructor(message = "Invalid webhook signature") {
    super(message);
    this.name = "WebhookVerificationError";
  }
}
