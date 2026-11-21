import type {
  CreateDomainInput,
  DownloadedAttachment,
  EmailAdapterMode,
  ProviderDomain,
  ProviderWebhookEvent,
  ReceivedEmail,
  SendEmailInput,
  SendEmailResult,
} from "./types";

/**
 * The only surface the rest of the app uses to talk to the email provider.
 * Two implementations: `MockEmailAdapter` (demo/tests — no network) and
 * `LiveEmailAdapter` (Resend). Obtain one via `getEmailAdapter()`.
 *
 * Contract notes:
 *  - `sendEmail` NEVER throws for provider failures; it returns `{ ok: false }`
 *    with a classified error so the outbox can decide to retry.
 *  - `idempotencyKey` must be forwarded to the provider so a retried job can
 *    not produce a duplicate email.
 *  - Other methods throw `ProviderRequestError` on failure.
 */
export interface EmailAdapter {
  readonly mode: EmailAdapterMode;

  sendEmail(input: SendEmailInput, opts: { idempotencyKey: string }): Promise<SendEmailResult>;

  createDomain(input: CreateDomainInput): Promise<ProviderDomain>;
  getDomain(providerDomainId: string): Promise<ProviderDomain>;
  /** Triggers DNS verification, then returns the refreshed domain. */
  verifyDomain(providerDomainId: string): Promise<ProviderDomain>;
  deleteDomain(providerDomainId: string): Promise<void>;

  /** Fetch the full body/headers of an inbound email announced by an `email.received` webhook. */
  getReceivedEmail(providerEmailId: string): Promise<ReceivedEmail>;
  downloadReceivedAttachment(
    providerEmailId: string,
    providerAttachmentId: string,
  ): Promise<DownloadedAttachment>;

  /**
   * Verifies the signature of a webhook delivery and returns the parsed event.
   * Must be given the RAW request body string (not re-serialised JSON).
   * Throws `WebhookVerificationError` when invalid.
   */
  verifyWebhook(rawBody: string, headers: Headers): ProviderWebhookEvent;
}

export class ProviderRequestError extends Error {
  readonly statusCode: number | null;
  readonly retryable: boolean;
  constructor(message: string, statusCode: number | null = null, retryable = false) {
    super(message);
    this.name = "ProviderRequestError";
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

/** 408/409/425/429 and 5xx (or no status = network failure) are worth retrying. */
export function isRetryableStatus(statusCode: number | null): boolean {
  if (statusCode === null) return true;
  return statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}
