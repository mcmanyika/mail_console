import { Resend, type DomainRecords } from "resend";
import { isDemoMode } from "@/lib/env";
import type { DnsRecord } from "@/lib/types/database";
import { ProviderRequestError, isRetryableStatus, type EmailAdapter } from "./adapter";
import { verifySvixWebhook } from "./webhook-verify";
import {
  type CreateDomainInput,
  type DownloadedAttachment,
  type ProviderDomain,
  type ProviderDomainStatus,
  type ProviderWebhookEvent,
  type ReceivedEmail,
  type SendEmailInput,
  type SendEmailResult,
} from "./types";

type LiveOptions = {
  apiKey: string;
  webhookSecret?: string;
};

const DOMAIN_STATUSES: readonly ProviderDomainStatus[] = [
  "not_started",
  "pending",
  "verified",
  "partially_verified",
  "partially_failed",
  "failed",
  "temporary_failure",
];

function normalizeDomainStatus(status: string): ProviderDomainStatus {
  return (DOMAIN_STATUSES as readonly string[]).includes(status) ? (status as ProviderDomainStatus) : "pending";
}

function mapRecords(records: DomainRecords[]): DnsRecord[] {
  return records.map((r) => ({
    record: r.record,
    name: r.name,
    type: r.type,
    value: r.value,
    ttl: r.ttl,
    status: r.status,
    ...("priority" in r && typeof r.priority === "number" ? { priority: r.priority } : {}),
  }));
}

/** Real Resend implementation. Refuses to be constructed while DEMO_MODE is on. */
export class LiveEmailAdapter implements EmailAdapter {
  readonly mode = "live" as const;
  private readonly resend: Resend;
  private readonly webhookSecret: string | undefined;

  constructor(opts: LiveOptions) {
    if (isDemoMode()) {
      throw new Error("LiveEmailAdapter cannot be used while DEMO_MODE is enabled");
    }
    if (!opts.apiKey) throw new Error("RESEND_API_KEY is required for the live adapter");
    this.resend = new Resend(opts.apiKey);
    this.webhookSecret = opts.webhookSecret;
  }

  async sendEmail(input: SendEmailInput, opts: { idempotencyKey: string }): Promise<SendEmailResult> {
    try {
      const { data, error } = await this.resend.emails.send(
        {
          from: input.from,
          to: input.to,
          cc: input.cc?.length ? input.cc : undefined,
          bcc: input.bcc?.length ? input.bcc : undefined,
          replyTo: input.replyTo?.length ? input.replyTo : undefined,
          subject: input.subject,
          text: input.text,
          html: input.html,
          headers: input.headers,
          tags: input.tags,
          attachments: input.attachments?.map((a) => ({
            filename: a.filename,
            content: Buffer.from(a.content),
            contentType: a.contentType,
            contentId: a.contentId,
          })),
        } as Parameters<Resend["emails"]["send"]>[0],
        { idempotencyKey: opts.idempotencyKey },
      );
      if (error || !data) {
        const statusCode = error?.statusCode ?? null;
        return {
          ok: false,
          error: {
            message: error?.message ?? "Resend returned no data",
            statusCode,
            retryable: isRetryableStatus(statusCode),
            code: error?.name,
          },
        };
      }
      return { ok: true, providerEmailId: data.id };
    } catch (err) {
      // Network/SDK exception: unknown outcome, so retry — the idempotency key prevents duplicates.
      return {
        ok: false,
        error: { message: err instanceof Error ? err.message : "Unknown send error", statusCode: null, retryable: true },
      };
    }
  }

  async createDomain(input: CreateDomainInput): Promise<ProviderDomain> {
    const res = await this.resend.domains.create({
      name: input.hostname,
      region: input.region,
      capabilities: { sending: "enabled", receiving: input.enableReceiving === false ? "disabled" : "enabled" },
    });
    if (res.error || !res.data) throw this.toError(res.error, "Failed to create domain");
    return {
      providerDomainId: res.data.id,
      hostname: res.data.name,
      status: normalizeDomainStatus(res.data.status),
      sendingEnabled: res.data.capabilities.sending === "enabled",
      receivingEnabled: res.data.capabilities.receiving === "enabled",
      records: mapRecords(res.data.records),
    };
  }

  async getDomain(providerDomainId: string): Promise<ProviderDomain> {
    const res = await this.resend.domains.get(providerDomainId);
    if (res.error || !res.data) throw this.toError(res.error, "Failed to fetch domain");
    return {
      providerDomainId: res.data.id,
      hostname: res.data.name,
      status: normalizeDomainStatus(res.data.status),
      sendingEnabled: res.data.capabilities.sending === "enabled",
      receivingEnabled: res.data.capabilities.receiving === "enabled",
      records: mapRecords(res.data.records),
    };
  }

  async verifyDomain(providerDomainId: string): Promise<ProviderDomain> {
    const res = await this.resend.domains.verify(providerDomainId);
    if (res.error) throw this.toError(res.error, "Failed to start domain verification");
    return this.getDomain(providerDomainId);
  }

  async deleteDomain(providerDomainId: string): Promise<void> {
    const res = await this.resend.domains.remove(providerDomainId);
    if (res.error) throw this.toError(res.error, "Failed to delete domain");
  }

  async getReceivedEmail(providerEmailId: string): Promise<ReceivedEmail> {
    // 'cid' keeps <img src="cid:..."> references so inline images can be mapped to attachments.
    const res = await this.resend.emails.receiving.get(providerEmailId, { html_format: "cid" });
    if (res.error || !res.data) throw this.toError(res.error, "Failed to fetch received email");
    const e = res.data;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(e.headers ?? {})) headers[k.toLowerCase()] = String(v);
    return {
      providerEmailId: e.id,
      from: e.from,
      to: e.to ?? [],
      cc: e.cc ?? [],
      bcc: e.bcc ?? [],
      replyTo: e.reply_to ?? [],
      subject: e.subject ?? "",
      text: e.text,
      html: e.html,
      headers,
      messageId: e.message_id ?? headers["message-id"] ?? null,
      receivedAt: e.created_at,
      attachments: (e.attachments ?? []).map((a) => ({
        providerAttachmentId: a.id,
        filename: a.filename,
        contentType: a.content_type,
        size: a.size,
        contentId: a.content_id,
        disposition: a.content_disposition,
      })),
    };
  }

  async downloadReceivedAttachment(providerEmailId: string, providerAttachmentId: string): Promise<DownloadedAttachment> {
    const meta = await this.resend.emails.receiving.attachments.get({ emailId: providerEmailId, id: providerAttachmentId });
    if (meta.error || !meta.data) throw this.toError(meta.error, "Failed to fetch attachment metadata");
    // download_url is a short-lived provider-signed URL; do not forward credentials to it.
    const response = await fetch(meta.data.download_url, { redirect: "follow" });
    if (!response.ok) {
      throw new ProviderRequestError(`Attachment download failed (${response.status})`, response.status, isRetryableStatus(response.status));
    }
    return {
      filename: meta.data.filename ?? "attachment",
      contentType: meta.data.content_type,
      data: new Uint8Array(await response.arrayBuffer()),
    };
  }

  verifyWebhook(rawBody: string, headers: Headers): ProviderWebhookEvent {
    if (!this.webhookSecret) throw new Error("RESEND_WEBHOOK_SECRET is required to verify webhooks");
    // svix >= 2.x `Webhook.verify()` returns void (no parsed payload) — see webhook-verify.ts.
    return verifySvixWebhook(rawBody, headers, this.webhookSecret);
  }

  private toError(
    error: { message: string; statusCode: number | null } | null | undefined,
    fallback: string,
  ): ProviderRequestError {
    const statusCode = error?.statusCode ?? null;
    return new ProviderRequestError(error?.message ?? fallback, statusCode, isRetryableStatus(statusCode));
  }
}
