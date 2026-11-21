import { z } from "zod";
import { authenticateApiKey, integrationMayUseMailbox, type IntegrationContext } from "@/lib/auth/authz";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/types/database";
import { aggregateDeliveryStatus } from "./delivery";
import {
  ComposeError,
  assertContent,
  discardDraftRow,
  insertDraftMessage,
  normalizeRecipientLists,
  resolveSender,
} from "./compose";
import {
  attachMessage,
  beginIdempotentRequest,
  completeIdempotentRequest,
  enqueueKeyFor,
  hashRequest,
  releaseIdempotentRequest,
} from "./idempotency";
import { enqueueOutboundMessage } from "./outbox";
import { consumeApiRateLimit, rateLimitHeaders, type RateLimitResult } from "./rate-limit";
import { makeSnippet, sanitizeEmailHtml } from "./sanitize";
import { TemplateError, renderTemplate, type TemplateVars } from "./templates";
import { generateRfcMessageId } from "./threading";

/**
 * Transactional email API core (POST/GET /api/v1/emails).
 * The workspace is ALWAYS derived from the API key; nothing in the request
 * body or headers can select or widen it.
 */

export const API_MAX_BODY_BYTES = 1_000_000; // whole JSON request

export type ApiResult = { status: number; body: unknown; headers?: Record<string, string> };

export function apiError(
  status: number,
  code: string,
  message: string,
  extra: { headers?: Record<string, string>; details?: unknown } = {},
): ApiResult {
  return {
    status,
    body: { error: { code, message, ...(extra.details !== undefined ? { details: extra.details } : {}) } },
    headers: extra.headers,
  };
}

// ---- request schema -----------------------------------------------------------------------------------
const addressList = z
  .union([z.email().max(254), z.array(z.email().max(254)).max(50)])
  .transform((v) => (Array.isArray(v) ? v : [v]));

const variablesSchema = z
  .record(
    z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/),
    z.union([z.string().max(5_000), z.number().finite(), z.boolean()]),
  )
  .refine((v) => Object.keys(v).length <= 50, "at most 50 variables");

export const sendEmailRequestSchema = z
  .strictObject({
    mailbox_id: z.uuid().optional(),
    from: z.email().max(254).optional(),
    to: addressList.pipe(z.array(z.string()).min(1)),
    cc: addressList.optional(),
    bcc: addressList.optional(),
    reply_to: z.email().max(254).optional(),
    template: z.string().min(1).max(120).optional(),
    variables: variablesSchema.optional(),
    subject: z.string().min(1).max(998).optional(),
    text: z.string().max(256_000).optional(),
    html: z.string().max(512_000).optional(),
  })
  .superRefine((v, ctx) => {
    if (Boolean(v.mailbox_id) === Boolean(v.from)) {
      ctx.addIssue({ code: "custom", message: "provide exactly one of mailbox_id or from", path: ["mailbox_id"] });
    }
    const hasInline = v.subject !== undefined || v.text !== undefined || v.html !== undefined;
    if (v.template && hasInline) {
      ctx.addIssue({ code: "custom", message: "use either template(+variables) or subject+text/html, not both", path: ["template"] });
    } else if (!v.template) {
      if (!v.subject) ctx.addIssue({ code: "custom", message: "subject is required without a template", path: ["subject"] });
      if (!v.text?.trim() && !v.html?.trim()) ctx.addIssue({ code: "custom", message: "text or html is required without a template", path: ["text"] });
      if (v.variables) ctx.addIssue({ code: "custom", message: "variables are only valid with a template", path: ["variables"] });
    }
  });

export type SendEmailRequest = z.infer<typeof sendEmailRequestSchema>;

const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/; // printable ASCII, no spaces

// ---- authentication + limits ---------------------------------------------------------------------------
/** Shared by POST and GET: 401 for unknown/revoked/suspended keys, 429 over limit. */
export async function authenticateAndLimit(
  admin: AdminClient,
  request: Request,
): Promise<{ ok: true; ctx: IntegrationContext; limit: RateLimitResult } | { ok: false; result: ApiResult }> {
  const ctx = await authenticateApiKey(admin, request.headers.get("authorization"));
  if (!ctx) {
    return {
      ok: false,
      result: apiError(401, "unauthorized", "Missing, invalid, revoked or suspended API key", {
        headers: { "WWW-Authenticate": 'Bearer realm="mail-console"' },
      }),
    };
  }
  let limit: RateLimitResult;
  try {
    limit = await consumeApiRateLimit(admin, ctx.integration.id);
  } catch {
    return { ok: false, result: apiError(503, "rate_limiter_unavailable", "Please retry shortly") };
  }
  if (!limit.allowed) {
    return {
      ok: false,
      result: apiError(429, "rate_limited", "Too many requests", { headers: rateLimitHeaders(limit) }),
    };
  }
  return { ok: true, ctx, limit };
}

async function readJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; result: ApiResult }> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > API_MAX_BODY_BYTES) return { ok: false, result: apiError(413, "payload_too_large", "Request body is too large") };
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > API_MAX_BODY_BYTES) {
    return { ok: false, result: apiError(413, "payload_too_large", "Request body is too large") };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, result: apiError(400, "invalid_json", "Request body must be valid JSON") };
  }
}

// ---- POST /api/v1/emails ---------------------------------------------------------------------------------
export async function handleCreateEmail(admin: AdminClient, request: Request): Promise<ApiResult> {
  const auth = await authenticateAndLimit(admin, request);
  if (!auth.ok) return auth.result;
  const { integration } = auth.ctx;
  const rlHeaders = rateLimitHeaders(auth.limit);
  const withHeaders = (r: ApiResult): ApiResult => ({ ...r, headers: { ...rlHeaders, ...r.headers } });

  const idemHeader = request.headers.get("idempotency-key");
  if (idemHeader !== null && !IDEMPOTENCY_KEY_RE.test(idemHeader)) {
    return withHeaders(apiError(400, "invalid_idempotency_key", "Idempotency-Key must be 1-255 printable ASCII characters"));
  }

  const body = await readJsonBody(request);
  if (!body.ok) return withHeaders(body.result);

  const parsed = sendEmailRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return withHeaders(
      apiError(422, "validation_error", "Request validation failed", {
        details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      }),
    );
  }
  const req = parsed.data;

  try {
    // Authorise the sender: it must live in THIS key's workspace and be allowed for this key.
    let sender;
    try {
      sender = await resolveSender(admin, req.mailbox_id ? { id: req.mailbox_id } : { address: req.from as string }, {
        workspaceId: integration.workspace_id,
      });
    } catch (err) {
      if (err instanceof ComposeError && err.code === "mailbox_not_found") {
        return withHeaders(apiError(403, "mailbox_not_permitted", "This key may not send from the requested mailbox"));
      }
      throw err;
    }
    if (!integrationMayUseMailbox(integration, sender.mailbox)) {
      return withHeaders(apiError(403, "mailbox_not_permitted", "This key may not send from the requested mailbox"));
    }

    const recipients = normalizeRecipientLists({ to: req.to, cc: req.cc, bcc: req.bcc });

    // Build content (template or inline).
    let subject: string;
    let text: string | null;
    let html: string | null;
    if (req.template) {
      const tpl = await loadTemplate(admin, integration.workspace_id, req.template);
      if (!tpl) return withHeaders(apiError(422, "template_not_found", "Template not found"));
      const rendered = renderTemplate(tpl, (req.variables ?? {}) as TemplateVars);
      ({ subject, text, html } = rendered);
    } else {
      subject = req.subject as string;
      text = req.text ?? null;
      html = req.html ?? null;
    }
    assertContent({ subject, text, html }, { requireBody: true });
    // Never send script/active content, even from a trusted integration (remote images stay allowed outbound).
    const safeHtml = html ? sanitizeEmailHtml(html, { allowRemoteImages: true }) : null;

    // Idempotency (after validation so bad requests never burn a key).
    const key = idemHeader ?? `auto:${crypto.randomUUID()}`;
    const requestHash = hashRequest({
      ...req,
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
    });
    const begin = await beginIdempotentRequest(admin, {
      workspaceId: integration.workspace_id,
      integrationId: integration.id,
      key,
      requestHash,
    });
    if (begin.kind === "conflict") {
      return withHeaders(apiError(409, "idempotency_key_reuse", "This Idempotency-Key was already used with a different request payload"));
    }
    if (begin.kind === "in_progress") {
      return withHeaders(apiError(409, "request_in_progress", "A request with this Idempotency-Key is still being processed", { headers: { "Retry-After": "2" } }));
    }
    if (begin.kind === "replay") {
      return withHeaders({ status: begin.status, body: begin.body, headers: { "Idempotent-Replayed": "true", ...locationFor(begin.body) } });
    }

    const rowId = begin.row.id;
    let messageId = begin.row.message_id;
    try {
      if (!messageId) {
        messageId = await insertDraftMessage(admin, {
          sender,
          integrationId: integration.id,
          recipients,
          subject,
          text,
          html: safeHtml,
          replyTo: req.reply_to ?? null,
          snippet: makeSnippet({ text, html: safeHtml }),
        });
        await attachMessage(admin, rowId, messageId);
      }

      const enq = await enqueueOutboundMessage(admin, {
        messageId,
        idempotencyKey: enqueueKeyFor(integration.id, key),
        recipients,
        rfcMessageId: generateRfcMessageId(sender.rfcDomain),
      });

      if (enq.status === "queued" || enq.status === "already_queued") {
        const responseBody: Json = { id: enq.messageId, status: "queued" };
        await completeIdempotentRequest(admin, rowId, { status: 202, body: responseBody, messageId: enq.messageId });
        return withHeaders({ status: 202, body: responseBody, headers: locationFor(responseBody) });
      }

      // Not enqueued: unwind so the client can retry with the same key.
      await releaseIdempotentRequest(admin, rowId);
      await discardDraftRow(admin, messageId);
      if (enq.status === "quota_exceeded") {
        return withHeaders(apiError(429, "quota_exceeded", "Monthly sending quota exceeded", { headers: { "Retry-After": "3600" } }));
      }
      if (enq.status === "workspace_inactive") {
        return withHeaders(apiError(403, "workspace_suspended", "This workspace may not send email"));
      }
      return withHeaders(apiError(422, "invalid_request", enq.status === "invalid" ? enq.reason : "Invalid request"));
    } catch (err) {
      // Pre-draft failure: free the key. Post-draft failure: keep the row so a retry resumes the same message.
      if (!messageId) await releaseIdempotentRequest(admin, rowId).catch(() => undefined);
      throw err;
    }
  } catch (err) {
    if (err instanceof ComposeError) {
      return withHeaders(apiError(err.status, err.code, err.message));
    }
    if (err instanceof TemplateError) {
      return withHeaders(apiError(422, "template_error", err.message));
    }
    console.error("[api/v1/emails] unexpected error", err instanceof Error ? err.message : err);
    return withHeaders(apiError(500, "internal_error", "Unexpected error"));
  }
}

function locationFor(body: unknown): Record<string, string> {
  const id = (body as { id?: unknown } | null)?.id;
  return typeof id === "string" ? { Location: `/api/v1/emails/${id}` } : {};
}

async function loadTemplate(admin: AdminClient, workspaceId: string, ref: string) {
  const isUuid = z.uuid().safeParse(ref).success;
  const { data, error } = await admin
    .from("email_templates")
    .select("subject, body_text, body_html")
    .eq("workspace_id", workspaceId)
    .eq(isUuid ? "id" : "name", ref)
    .maybeSingle();
  if (error) throw new Error(`template lookup failed: ${error.message}`);
  return data;
}

// ---- GET /api/v1/emails/[id] ------------------------------------------------------------------------------
export async function handleGetEmail(admin: AdminClient, request: Request, id: string): Promise<ApiResult> {
  const auth = await authenticateAndLimit(admin, request);
  if (!auth.ok) return auth.result;
  const { integration } = auth.ctx;
  const headers = rateLimitHeaders(auth.limit);

  if (!z.uuid().safeParse(id).success) return { ...apiError(404, "not_found", "Email not found"), headers };

  try {
    const { data: message, error } = await admin
      .from("messages")
      .select("id, mailbox_id, direction, lifecycle_state, from_address, subject, failure_reason, created_at, sent_at, created_by_integration_id")
      .eq("id", id)
      .eq("workspace_id", integration.workspace_id) // workspace comes from the key only
      .eq("direction", "outbound")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!message || !message.created_by_integration_id) return { ...apiError(404, "not_found", "Email not found"), headers };
    if (!integrationMayUseMailbox(integration, { id: message.mailbox_id, workspace_id: integration.workspace_id })) {
      return { ...apiError(404, "not_found", "Email not found"), headers };
    }

    const { data: recipients, error: rErr } = await admin
      .from("message_recipients")
      .select("address, type, delivery_state")
      .eq("message_id", message.id);
    if (rErr) throw new Error(rErr.message);

    return {
      status: 200,
      headers,
      body: {
        id: message.id,
        status: aggregateDeliveryStatus(message.lifecycle_state, (recipients ?? []).map((r) => r.delivery_state)),
        from: message.from_address,
        subject: message.subject,
        created_at: message.created_at,
        sent_at: message.sent_at,
        error: message.lifecycle_state === "failed" ? (message.failure_reason ?? "send failed") : null,
        recipients: (recipients ?? []).map((r) => ({ address: r.address, type: r.type, status: r.delivery_state })),
      },
    };
  } catch (err) {
    console.error("[api/v1/emails/:id] unexpected error", err instanceof Error ? err.message : err);
    return { ...apiError(500, "internal_error", "Unexpected error"), headers };
  }
}
