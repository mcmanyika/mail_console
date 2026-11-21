# Mail Console API

Machine-facing endpoints. All JSON. All of them are public to `src/proxy.ts`
(no browser session) and authenticate themselves.

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /api/v1/emails` | `Authorization: Bearer mck_…` | Queue a transactional email |
| `GET /api/v1/emails/{id}` | `Authorization: Bearer mck_…` | Poll status / delivery state |
| `POST /api/webhooks/resend` | Svix signature | Resend events (inbound mail, delivery events, domain updates) |
| `GET`/`POST /api/cron/outbox` | `Authorization: Bearer $CRON_SECRET` | Outbox worker tick |

Base URL in these examples: `http://localhost:3000` (set `DEMO_MODE=true` so nothing is ever really sent).

---

## Authentication (transactional API)

Create a key in **Settings → Integrations** (shown once). Keys look like
`mck_<8 chars>_<secret>`; only an HMAC of the key is stored.

```bash
export MCK="mck_demo0001_demo-secret-do-not-use-0000000000"   # seed.sql demo key (Overflow Connections, pinned to hello@)
```

* The **workspace is derived from the key only**. Nothing in the body/headers can
  select another workspace; unknown body fields are rejected (422).
* A key may be **workspace-wide** or **pinned to one mailbox**. Using any other mailbox → `403 mailbox_not_permitted`.
* Revoked keys and keys of **suspended workspaces** → `401` (indistinguishable from unknown keys on purpose).
* `From` is **never** supplied by the caller; it is resolved server-side from the approved mailbox
  (`"Display Name" <local@your-verified-domain>`). The sending domain must be `verified`.

## `POST /api/v1/emails`

Headers

| Header | Required | Notes |
| --- | --- | --- |
| `Authorization: Bearer mck_…` | yes | |
| `Content-Type: application/json` | yes | Body ≤ 1 MB |
| `Idempotency-Key` | recommended | 1–255 printable ASCII chars; kept for 24 h, scoped per key. Without it every request is treated as new. |

Body

| Field | Type | Notes |
| --- | --- | --- |
| `from` **or** `mailbox_id` | email / uuid | Exactly one. The approved sender mailbox (address or id). |
| `to` | email \| email[] | Required, ≤ 50 total recipients across `to`+`cc`+`bcc` (de-duplicated, case-insensitive) |
| `cc`, `bcc` | email \| email[] | optional |
| `reply_to` | email | optional |
| `template` + `variables` | string (name or id), object | Template from this workspace; `{{var}}` placeholders; values are HTML-escaped in the HTML body. Missing variable → 422. |
| `subject` + `text` and/or `html` | string | Use **either** a template **or** subject+body (not both). subject ≤ 998 chars, no line breaks; text ≤ 256 KB; html ≤ 512 KB (scripts/active content stripped). |

Attachments are not supported on this endpoint.

### Example: inline content

```bash
curl -i -X POST http://localhost:3000/api/v1/emails \
  -H "Authorization: Bearer $MCK" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-1042-receipt" \
  -d '{
    "from": "hello@overflowconnections.example",
    "to": "customer@customer-one.example",
    "subject": "Your receipt #1042",
    "text": "Thanks for your order!",
    "html": "<p>Thanks for your order!</p>"
  }'
```

```http
HTTP/1.1 202 Accepted
Location: /api/v1/emails/6f3c2a1e-0d6b-4b8e-9a53-0c1f2d3e4a5b
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 59

{"id":"6f3c2a1e-0d6b-4b8e-9a53-0c1f2d3e4a5b","status":"queued"}
```

### Example: template

```bash
curl -X POST http://localhost:3000/api/v1/emails \
  -H "Authorization: Bearer $MCK" -H "Content-Type: application/json" \
  -H "Idempotency-Key: welcome-user-77" \
  -d '{
    "mailbox_id": "d0000000-0000-4000-8000-000000000002",
    "to": ["new.member@example.com"],
    "template": "Welcome",
    "variables": { "first_name": "Nina" }
  }'
```

### Idempotency

| Situation | Result |
| --- | --- |
| Same key, same payload | `202` with the **original** `{id,status}` and header `Idempotent-Replayed: true`. No second email, no second quota charge. |
| Same key, **different** payload | `409 idempotency_key_reuse` |
| Same key while the first request is still running | `409 request_in_progress` (+ `Retry-After`) |
| First request crashed mid-way | The retry resumes the same message after the 60 s lock expires |
| Request rejected (quota, suspended…) | The key is released; retrying later with the same key is fine |

"Same payload" is compared after normalisation (recipients lower-cased/deduplicated, key order ignored).

### Errors

Shape: `{"error":{"code":"…","message":"…","details":[…]}}`

| HTTP | `code` | Meaning |
| --- | --- | --- |
| 400 | `invalid_json`, `invalid_idempotency_key` | |
| 401 | `unauthorized` | missing/invalid/revoked key or suspended workspace (`WWW-Authenticate: Bearer`) |
| 403 | `mailbox_not_permitted` (also returned for mailboxes of other workspaces, so existence is not leaked), `mailbox_disabled`, `workspace_suspended` | |
| 404 | `not_found` | GET only: unknown id or not owned by this key's workspace/integration |
| 409 | `idempotency_key_reuse`, `request_in_progress` | |
| 413 | `payload_too_large` | |
| 422 | `validation_error`, `invalid_recipient`, `too_many_recipients`, `invalid_content`, `template_not_found`, `template_error`, `sender_not_verified`, `invalid_request` | |
| 429 | `rate_limited` (`Retry-After`), `quota_exceeded` | per-key rate limit (default 60 req/min, `API_RATE_LIMIT_PER_MINUTE`), monthly workspace quota |
| 500 | `internal_error` | |
| 503 | `rate_limiter_unavailable` | retry shortly |

## `GET /api/v1/emails/{id}`

Returns messages created through the API **in the key's workspace** (and, for pinned keys, mailbox). Anything else is `404`.

```bash
curl -s http://localhost:3000/api/v1/emails/6f3c2a1e-0d6b-4b8e-9a53-0c1f2d3e4a5b -H "Authorization: Bearer $MCK"
```

```json
{
  "id": "6f3c2a1e-0d6b-4b8e-9a53-0c1f2d3e4a5b",
  "status": "delivered",
  "from": "\"Overflow Hello\" <hello@overflowconnections.example>",
  "subject": "Your receipt #1042",
  "created_at": "2026-11-20T21:00:00.000Z",
  "sent_at": "2026-11-20T21:00:04.000Z",
  "error": null,
  "recipients": [{ "address": "customer@customer-one.example", "type": "to", "status": "delivered" }]
}
```

`status`: `queued` → `sent` → `delivered` (or `delayed`, `bounced`, `complained`, `suppressed`, `failed`).
For several recipients the worst outcome wins; `delivered` only when every recipient is delivered.
Recipient states never go backwards (see [Delivery events](#delivery-events)).

---

## `POST /api/webhooks/resend`

Configure in Resend → Webhooks with events: `email.received`, `email.sent`, `email.delivered`,
`email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`,
`domain.created`, `domain.updated`. Signing secret → `RESEND_WEBHOOK_SECRET`.

* The Svix signature is verified against the **raw body** (re-formatted JSON fails). Missing secret → `503`,
  bad/stale signature → `400`.
* **Durable intake first:** the event is written to `webhook_events` (unique on provider + account + event id)
  and only then processed; duplicates are acknowledged without re-processing. If processing fails the endpoint
  answers `500` so Resend retries; the cron worker also retries stuck events (max 5 attempts, then parked as
  `failed` for ops review).

### Inbound (`email.received`)

* The body is fetched from Resend (`getReceivedEmail`); routing uses only **provider-supplied recipients**
  (`received_for` if present, otherwise `to`/`cc`/`bcc`) matched to **known, enabled mailboxes**
  (`+tag` falls back to the base address). Message headers such as `Delivered-To` / `X-Original-To` are never used.
* A message addressed to several known mailboxes produces **separate** thread/message/attachment records per mailbox,
  each scoped to that mailbox's workspace.
* Threading: `In-Reply-To` / `References` within the same mailbox, otherwise a new thread (the subject is
  never used to join a thread).
* Unmatched mail is kept as an `ignored` webhook event (`unmatched: no_known_recipient`) for ops review; no message
  content is fetched or exposed.
* HTML is sanitised (scripts/handlers/forms/iframes removed, `javascript:` blocked, remote images replaced by an inert
  placeholder with `data-blocked-src`); attachments go to the private `attachments` bucket and are served only via
  60-second signed URLs; filenames/MIME types are sanitised.
* Suspended workspaces still receive inbound mail.

### Delivery events

`email.sent|delivered|delivery_delayed|bounced|complained|failed|suppressed` update `message_recipients.delivery_state`.
State only moves forward by rank:
`pending < sent < delayed < delivered < failed = suppressed < bounced < complained`; duplicates and out-of-order
deliveries are no-ops. An event for an email id we don't know yet (it can beat our own bookkeeping) is retried, then parked.

### Try it locally (DEMO_MODE=true, unsigned)

Unsigned fixtures are accepted **only** when `DEMO_MODE=true` **and** the header `X-Mail-Console-Demo: 1` is sent.
In demo mode the mock provider has no stored mail, so content can be embedded in the event (`text`, `html`, `headers`):

```bash
curl -i -X POST http://localhost:3000/api/webhooks/resend \
  -H "Content-Type: application/json" -H "X-Mail-Console-Demo: 1" -H "svix-id: demo-evt-001" \
  -d '{
    "type": "email.received",
    "created_at": "2026-11-20T10:00:00.000Z",
    "data": {
      "email_id": "demo_recv_001",
      "from": "Priya Shah <priya@customer-one.example>",
      "to": ["support@overflowconnections.example"],
      "message_id": "<demo-recv-001@customer-one.example>",
      "subject": "Hello from the webhook demo",
      "text": "Hi team",
      "html": "<p>Hi team</p><script>alert(1)</script>"
    }
  }'
# => 200 {"ok":true,"duplicate":false,"status":"processed"}  (script is stripped; replaying the same svix-id => "duplicate":true)
```

Synthetic fixtures used by the tests live in `src/lib/email/fixtures/` (`email.received.json`,
`email.received.multi.json`, `email.received.unmatched.json`, `email.received.spoofed-headers.json`,
`email.delivered.json`, `email.bounced.json`, `email.delivery_delayed.json`).

---

## `GET|POST /api/cron/outbox`

```bash
curl -s -X POST http://localhost:3000/api/cron/outbox -H "Authorization: Bearer $CRON_SECRET"
# {"ok":true,"adapter":"mock","outbox":{"ticks":1,"claimed":1,"succeeded":1,"retryScheduled":0,"failed":0,"dead":0,"skipped":0},"webhooks":{…},"ms":42}
```

* `401` wrong/missing token; `503` when `CRON_SECRET` is not configured (fails closed).
* Claims due jobs with `FOR UPDATE SKIP LOCKED` + leases, sends through the adapter with the stable provider
  idempotency key `mc-outbox-<job id>`, retries transient failures with exponential backoff (15 s … 1 h, max 6 attempts),
  settles quota on success and releases it on permanent failure.
* Also re-processes stuck webhook events and prunes expired idempotency keys.
* Vercel Cron calls routes with `GET`; `vercel.json` schedules it every minute (Vercel Hobby only allows daily crons).

---

## Server actions (UI-facing)

All are thin wrappers (`src/app/actions/*`) over testable services (`src/lib/services/*`, `src/lib/resend/domains.ts`).
They authenticate the Supabase session, never accept a `From`, and return
`{ ok: true, … } | { ok: false, code, error }`.

| Action | Service | Authorization |
| --- | --- | --- |
| `saveDraftAction`, `discardDraftAction` | `saveDraft`, `discardDraft` | `requireMailboxAccess(…, "send")`; drafts private to the author (other users get 404) |
| `sendDraftAction`, `sendMessageAction` | `sendDraft`, `composeAndSend` | same; idempotent per draft; quota + suspension enforced in `enqueue_outbound_message` |
| `replyAction` | `replyToMessage` | `send` on the parent's mailbox; sets `In-Reply-To`/`References`, keeps thread |
| `forwardAction` | `forwardMessage` | `read` on the original, `send` on the destination mailbox (same workspace); new thread, attachments copied |
| `archiveThreadAction`, `unarchiveThreadAction`, `markThreadReadAction`, `markThreadUnreadAction` | `setThreadState` | `read` on the thread's mailbox (per-user state) |
| `getAttachmentUrlAction` | `getAttachmentSignedUrl` | `read` + draft privacy; 60 s signed URL, forced download |
| `createDomainAction`, `verifyDomainAction` / `recheckDomainAction`, `getDomainDnsAction`, `suggestDomainAction` | `src/lib/resend/domains.ts` | workspace owner/admin or platform admin |
| `createWorkspaceAction`, `inviteOwnerAction`, `suspendWorkspaceAction`, `reinstateWorkspaceAction`, `setWorkspaceLimitsAction` | `src/lib/services/admin.ts` | `requirePlatformAdmin` first |

Domains are created with **sending + receiving** and default to the suggestion `mail.{apex}`.
`mapDnsRecords()` turns provider records into `{ purpose, type, host (FQDN), value, ttl, priority, status }`.

Suspending a workspace: new sends are refused (UI and API → `workspace_suspended` / 401), already queued jobs fail
at send time and release their quota, **inbound mail keeps arriving**.
