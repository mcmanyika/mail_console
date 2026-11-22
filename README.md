# Mail Console

Multi-tenant shared inbox + transactional email console on **Next.js 16**, **Supabase** (Postgres, RLS, private
Storage) and **Resend**. Workspaces own verified domains and mailboxes; people read/send through the inbox UI,
apps send through a small API.

* Inbound: Resend `email.received` webhook → sanitised, mailbox-scoped threads/messages/attachments.
* Outbound: transactional **outbox** (quota reserve → queue → worker → provider with idempotency key → settle).
* Optional **OpenAI assist**: summarize threads, suggest replies, improve drafts (mailbox-grant scoped; per-workspace toggle + monthly AI quota). Enable in **Settings → AI** after setting `OPENAI_API_KEY`.
* API reference and curl examples: **[docs/api.md](docs/api.md)**.

`DEMO_MODE=true` (the default in `.env.example`) uses a **mock Resend adapter**: no network calls to Resend and
no real email is ever sent.

## Local development

Prerequisites: Node ≥ 20.9 (Node 22 recommended — the HTML sanitizer test needs ≥ 20.19 / 22.12), Docker, the
[Supabase CLI](https://supabase.com/docs/guides/local-development).

```bash
npm install
cp .env.example .env.local        # keep DEMO_MODE=true

# Local Supabase (first time only: `supabase init` if supabase/config.toml does not exist)
npm run db:start                  # supabase start — prints API URL, anon key, service_role key
# paste those into .env.local (NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY / SUPABASE_SERVICE_ROLE_KEY)

npm run db:reset                  # applies supabase/migrations/00001…00004 + supabase/seed.sql (demo data) — LOCAL ONLY
npm run dev                       # http://localhost:3000
```

Useful scripts: `npm test` (vitest), `npm run typecheck`, `npm run lint`, `npm run build`.

Seed data (synthetic, see header of `supabase/seed.sql` for demo logins): three workspaces, mock-verified
domains, mailboxes with per-user access grants, threads, templates and a demo API key
`mck_demo0001_demo-secret-do-not-use-0000000000`.

In demo mode, drive the pipeline by hand:

```bash
# queue a mail through the API, then run the worker once (mock adapter => nothing leaves your machine)
curl -X POST localhost:3000/api/v1/emails -H "Authorization: Bearer mck_demo0001_demo-secret-do-not-use-0000000000" \
  -H "Content-Type: application/json" -H "Idempotency-Key: demo-1" \
  -d '{"from":"hello@overflowconnections.example","to":"someone@example.com","subject":"Hi","text":"Hello"}'
curl -X POST localhost:3000/api/cron/outbox -H "Authorization: Bearer $CRON_SECRET"
```

See [docs/api.md](docs/api.md) for simulating inbound mail with an unsigned fixture
(`X-Mail-Console-Demo: 1`, accepted only when `DEMO_MODE=true`).

## DEMO_MODE

| | `DEMO_MODE=true` | `DEMO_MODE=false` |
| --- | --- | --- |
| Provider | mock adapter (in-process) | live Resend (needs `RESEND_API_KEY`) |
| Webhook signature | Svix verified if a secret is set; unsigned fixtures allowed **only** with header `X-Mail-Console-Demo: 1` | Svix signature always required; the demo header is ignored |
| Domains | created/“verified” instantly by the mock | real DNS records, real verification |

If `RESEND_API_KEY` is missing the app also falls back to the mock. **Never set `DEMO_MODE=true` on a production
deployment that receives real traffic.**

## Environment variables

Authoritative list with comments: [`.env.example`](.env.example).

| Variable | Needed for live integration | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_URL` | yes | public origin (invite links, redirects) |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | server only; bypasses RLS |
| `DEMO_MODE` | set `false` | |
| `RESEND_API_KEY` | yes | “Full access” key (domains + sending + receiving) |
| `RESEND_WEBHOOK_SECRET` | yes | `whsec_…` of the webhook endpoint; missing → webhook answers 503 |
| `RESEND_ACCOUNT_LABEL` | optional | part of the webhook-event uniqueness key |
| `CRON_SECRET` | yes | bearer secret for `/api/cron/outbox` (Vercel sends it automatically); unset → 503 |
| `API_KEY_PEPPER` | yes | ≥ 32 random chars; rotating it invalidates all API keys + invites |
| `OPENAI_API_KEY` | optional | enables inbox AI (summarize / suggest reply / improve); enable per workspace in Settings → AI |
| `OPENAI_MODEL` | optional | default `gpt-4o-mini` |
| `API_RATE_LIMIT_PER_MINUTE` | optional | default 60 per API key |
| `OUTBOX_BATCH_SIZE`, `OUTBOX_MAX_ATTEMPTS`, `OUTBOX_LEASE_SECONDS`, `MAX_ATTACHMENT_BYTES` | optional | worker tuning |

## Deploying to Vercel (not done by this repo's tooling)

1. Create a hosted Supabase project; apply migrations (`supabase link` + `supabase db push`). Do **not** run
   `seed.sql` against it. The migrations create the private `attachments` bucket.
2. Import the repo in Vercel and set the env vars above (`DEMO_MODE=false`).
3. **Cron:** `vercel.json` registers `/api/cron/outbox` every minute. Vercel Cron issues a `GET` with
   `Authorization: Bearer $CRON_SECRET`. Per-minute schedules need a Pro plan; on Hobby use a daily schedule or an
   external scheduler (e.g. GitHub Actions / Supabase pg_cron) calling the endpoint with the bearer token. The
   function sets `maxDuration = 60`.
4. **Webhook:** in Resend → Webhooks add `https://<your-domain>/api/webhooks/resend` and subscribe to
   `email.received`, `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`,
   `email.complained`, `email.failed`, `email.suppressed`, `domain.created`, `domain.updated`. Copy the signing
   secret into `RESEND_WEBHOOK_SECRET`.
5. Add the workspace domain in the console (suggested `mail.<apex>`), publish the DNS records it shows
   (SPF/DKIM for sending, MX for receiving), then **Verify**.

## Resend documentation used

* Verify webhooks (Svix, raw body): <https://resend.com/docs/webhooks/verify-webhooks-requests>
* Webhook event types: <https://resend.com/docs/webhooks/event-types>
* Managing domains / create & verify: <https://resend.com/docs/dashboard/domains/introduction>, <https://resend.com/docs/api-reference/domains/create-domain>, <https://resend.com/docs/api-reference/domains/verify-domain>
* Receiving emails: <https://resend.com/docs/dashboard/receiving/introduction>, <https://resend.com/docs/api-reference/emails/retrieve-received-email>
* Sending & idempotency keys: <https://resend.com/docs/api-reference/emails/send-email>, <https://resend.com/docs/dashboard/emails/idempotency-keys>
* Svix verification: <https://docs.svix.com/receiving/verifying-payloads/how>

## Architecture notes

* **Authorization:** every inbox action calls `requireMailboxAccess` (explicit per-mailbox grant for every role,
  owners included; platform admins get none). Drafts are private to their author. Platform operations call
  `requirePlatformAdmin`.
* **Tenancy:** the API derives the workspace from the hashed API key only; inbound routing uses only
  provider-supplied recipients matched to known enabled mailboxes.
* **Suspension:** blocks new outbound (UI + API) but inbound mail keeps being stored.
* **Reliability:** webhook events are persisted before acknowledgement, deduplicated by provider event id and
  reprocessed by the cron worker; delivery state never regresses; outbound uses `mc-outbox-<job id>` as the
  provider idempotency key.
* Code map: `src/lib/email/*` (pipeline), `src/lib/resend/*` (adapters + domains), `src/lib/services/*`
  (inbox/admin services used by tests), `src/lib/actions/*` (UI server actions), `src/app/api/*` (route handlers),
  `src/lib/email/fixtures/*` (synthetic webhook fixtures), `src/lib/testing/*` (in-memory Supabase fake for tests).
