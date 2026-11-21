import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./sanitize", async (importOriginal) => {
  try {
    return await importOriginal<typeof import("./sanitize")>();
  } catch {
    return await import("../testing/sanitize-fallback");
  }
});

const holder = vi.hoisted(() => ({ admin: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => holder.admin }));

import { GET as getEmail } from "@/app/api/v1/emails/[id]/route";
import { POST as postEmail } from "@/app/api/v1/emails/route";
import { MockEmailAdapter } from "@/lib/resend/mock";
import { seedWorld, type World } from "@/lib/testing/world";
import { deliveryFixture, fixtures, signedWebhook, TEST_WEBHOOK_SECRET } from "./fixtures";
import { processOutboxBatch } from "./outbox";
import { handleResendWebhook } from "./webhooks";
import { currentYearMonth } from "./quota";

let w: World;

beforeEach(() => {
  w = seedWorld();
  holder.admin = w.admin;
});
afterEach(() => vi.unstubAllEnvs());

type Opts = { key?: string | null; idem?: string; body?: unknown; raw?: string };
function post({ key, idem, body, raw }: Opts = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (key !== null) headers.set("authorization", `Bearer ${key ?? w.keys.a}`);
  if (idem) headers.set("idempotency-key", idem);
  return postEmail(new Request("http://localhost/api/v1/emails", { method: "POST", headers, body: raw ?? JSON.stringify(body ?? valid()) }));
}
const valid = (over: Record<string, unknown> = {}) => ({
  from: "support@a.example",
  to: "customer@customer.example",
  subject: "Your receipt",
  text: "Thanks for your order",
  ...over,
});
const get = (id: string, key = w.keys.a) =>
  getEmail(new Request(`http://localhost/api/v1/emails/${id}`, { headers: { authorization: `Bearer ${key}` } }), { params: Promise.resolve({ id }) });

const outbound = () => w.db.rows("messages").filter((m) => m.direction === "outbound");

describe("POST /api/v1/emails", () => {
  it("returns 202 { id, status: queued } and queues exactly one outbound message", async () => {
    const res = await post({ idem: "k-1" });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ id: expect.any(String), status: "queued" });
    expect(res.headers.get("location")).toBe(`/api/v1/emails/${body.id}`);

    const [m] = outbound();
    expect(m).toMatchObject({ id: body.id, workspace_id: w.ids.wsA, mailbox_id: w.ids.mbA1, lifecycle_state: "queued", created_by_integration_id: w.integrations.a });
    expect(m.from_address).toBe('"A Support" <support@a.example>'); // resolved server-side
    expect(m.rfc_message_id).toMatch(/^<[^@]+@a\.example>$/);
    expect(w.db.rows("outbox_jobs")).toHaveLength(1);
  });

  it("same key + same payload returns the original; no second message or quota reservation", async () => {
    const a = await post({ idem: "dup-1" });
    const b = await post({ idem: "dup-1" });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect((await b.json()).id).toBe((await a.json()).id);
    expect(outbound()).toHaveLength(1);
    expect(w.db.rows("monthly_usage")[0].reserved_count).toBe(1);
  });

  it("treats recipient case/duplicates as the same payload", async () => {
    await post({ idem: "norm-1", body: valid({ to: ["Customer@Customer.example"] }) });
    const again = await post({ idem: "norm-1", body: valid({ to: ["customer@customer.example", "customer@customer.example"] }) });
    expect(again.status).toBe(202);
    expect(outbound()).toHaveLength(1);
  });

  it("same key + different payload => 409", async () => {
    await post({ idem: "dup-2" });
    const res = await post({ idem: "dup-2", body: valid({ subject: "Something else" }) });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("idempotency_key_reuse");
    expect(outbound()).toHaveLength(1);
  });

  it("idempotency keys are scoped per integration", async () => {
    const a = await post({ idem: "shared" });
    const b = await post({ idem: "shared", key: w.keys.a1Only });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(outbound()).toHaveLength(2);
  });

  it("a retry after a crash (message created, never enqueued) resumes the same message", async () => {
    const first = await post({ idem: "crash-1" });
    const { id } = await first.json();
    // simulate crash: roll the request back to 'draft' + incomplete + stale lock, and drop the job
    const row = w.db.rows("api_idempotency_keys")[0];
    Object.assign(row, { completed_at: null, response_status: null, response_body: null, locked_at: new Date(Date.now() - 5 * 60_000).toISOString() });
    w.db.tables.set("outbox_jobs", []);
    const m = w.db.rows("messages")[0];
    Object.assign(m, { direction: "draft", lifecycle_state: "draft" });

    const retry = await post({ idem: "crash-1" });
    expect(retry.status).toBe(202);
    expect((await retry.json()).id).toBe(id);
    expect(w.db.rows("messages")).toHaveLength(1);
  });

  it("a request still in flight answers 409 request_in_progress", async () => {
    await post({ idem: "inflight" });
    Object.assign(w.db.rows("api_idempotency_keys")[0], { completed_at: null, response_status: null, response_body: null });
    const res = await post({ idem: "inflight" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("request_in_progress");
  });

  describe("authentication", () => {
    it("401 without / with malformed / unknown keys", async () => {
      expect((await post({ key: null })).status).toBe(401);
      expect((await post({ key: "not-a-key" })).status).toBe(401);
      expect((await post({ key: "mck_zzzzzzzz_" + "x".repeat(43) })).status).toBe(401);
      expect(outbound()).toHaveLength(0);
    });

    it("401 for a revoked key", async () => {
      const res = await post({ key: w.keys.revoked });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
      expect(outbound()).toHaveLength(0);
    });

    it("a key revoked after first use stops working immediately", async () => {
      expect((await post({ idem: "r1" })).status).toBe(202);
      w.db.rows("app_integrations").find((i) => i.id === w.integrations.a)!.revoked_at = new Date().toISOString();
      expect((await post({ idem: "r2" })).status).toBe(401);
      expect(outbound()).toHaveLength(1);
    });

    it("401 when the workspace is suspended (no new outbound via API)", async () => {
      w.db.rows("workspaces").find((x) => x.id === w.ids.wsA)!.status = "suspended";
      const res = await post();
      expect(res.status).toBe(401);
      expect(w.db.rows("messages")).toHaveLength(0);
    });

    it("403 if the workspace is suspended between authentication and enqueue", async () => {
      // authenticate passes, then enqueue sees a non-active workspace
      const original = w.admin.rpc.bind(w.admin);
      vi.spyOn(w.admin, "rpc").mockImplementation(((name: string, args: never) => {
        if (name === "enqueue_outbound_message") w.db.rows("workspaces").find((x) => x.id === w.ids.wsA)!.status = "suspended";
        return original(name as never, args);
      }) as never);
      const res = await post({ idem: "race-susp" });
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("workspace_suspended");
      expect(w.db.rows("messages")).toHaveLength(0); // draft unwound
      expect(w.db.rows("api_idempotency_keys")).toHaveLength(0); // key released
    });
  });

  describe("tenant derivation and sender approval", () => {
    it("workspace comes from the key only: workspace A's key cannot send from B's mailbox (by id or address)", async () => {
      const byId = await post({ body: valid({ from: undefined, mailbox_id: w.ids.mbB1 }) });
      const byAddr = await post({ body: valid({ from: "support@b.example" }) });
      expect(byId.status).toBe(403);
      expect(byAddr.status).toBe(403);
      expect(w.db.rows("messages")).toHaveLength(0);
    });

    it("rejects unknown body fields such as workspace_id / raw From override", async () => {
      const res = await post({ body: valid({ workspace_id: w.ids.wsB }) });
      expect(res.status).toBe(422);
      const res2 = await post({ body: valid({ headers: { From: "ceo@a.example" } }) });
      expect(res2.status).toBe(422);
    });

    it("a mailbox-pinned key may only use its mailbox", async () => {
      const ok = await post({ key: w.keys.a1Only, body: valid() });
      const bad = await post({ key: w.keys.a1Only, body: valid({ from: "hello@a.example" }) });
      expect(ok.status).toBe(202);
      expect(bad.status).toBe(403);
    });

    it("rejects unverified sending domains and disabled mailboxes", async () => {
      w.db.rows("domains").find((d) => d.id === w.ids.domA)!.send_status = "pending";
      expect((await post()).status).toBe(422);
      w.db.rows("domains").find((d) => d.id === w.ids.domA)!.send_status = "verified";
      w.db.rows("mailboxes").find((m) => m.id === w.ids.mbA1)!.enabled = false;
      expect((await post()).status).toBe(403);
    });
  });

  describe("validation", () => {
    it.each([
      ["no recipient", { to: [] }],
      ["bad recipient", { to: "not-an-email" }],
      ["too many recipients", { to: Array.from({ length: 51 }, (_, i) => `u${i}@x.example`) }],
      ["no subject", { subject: undefined }],
      ["no body", { text: undefined }],
      ["subject too long", { subject: "s".repeat(999) }],
      ["text too large", { text: "t".repeat(256_001) }],
      ["html too large", { html: "h".repeat(512_001) }],
      ["template + inline", { template: "welcome" }],
      ["both mailbox_id and from", { mailbox_id: "00000000-0000-4000-8000-0000000000aa" }],
    ])("422 for %s", async (_name, over) => {
      const res = await post({ body: valid(over) });
      expect(res.status).toBe(422);
      expect(w.db.rows("messages")).toHaveLength(0);
    });

    it("422 for header-injection attempts in the subject", async () => {
      const res = await post({ body: valid({ subject: "Hi\r\nBcc: victim@evil.example" }) });
      expect(res.status).toBe(422);
    });

    it("400 for invalid JSON and 413 for oversized bodies", async () => {
      expect((await post({ raw: "{nope" })).status).toBe(400);
      expect((await post({ raw: JSON.stringify(valid({ text: "x".repeat(1_100_000) })) })).status).toBe(413);
    });

    it("400 for a malformed Idempotency-Key", async () => {
      expect((await post({ idem: "has space" })).status).toBe(400);
    });
  });

  describe("templates", () => {
    it("renders template + variables (HTML-escaped) and 422s on missing variables", async () => {
      const res = await post({ body: { from: "support@a.example", to: "c@x.example", template: "welcome", variables: { name: "<b>Ann</b>", code: 42 } } });
      expect(res.status).toBe(202);
      const m = outbound()[0];
      expect(m.subject).toBe("Welcome, <b>Ann</b>"); // subject/text are not HTML contexts
      expect(m.text_body).toBe("Hi <b>Ann</b>, your code is 42.");
      expect(m.html_body).toContain("&lt;b&gt;Ann&lt;/b&gt;");
      expect(m.html_body).not.toContain("<b>Ann</b>");

      const missing = await post({ body: { from: "support@a.example", to: "c@x.example", template: "welcome", variables: { name: "Ann" } } });
      expect(missing.status).toBe(422);
      const unknown = await post({ body: { from: "support@a.example", to: "c@x.example", template: "nope" } });
      expect(unknown.status).toBe(422);
    });

    it("templates are workspace scoped", async () => {
      const res = await post({ key: w.keys.b, body: { from: "support@b.example", to: "c@x.example", template: "welcome", variables: { name: "A", code: 1 } } });
      expect(res.status).toBe(422); // B has no 'welcome' template
    });
  });

  it("strips active content from caller-supplied HTML", async () => {
    await post({ body: valid({ html: '<p>Hi</p><script>alert(1)</script><img src="x" onerror="y()">' }) });
    expect(String(outbound()[0].html_body)).not.toMatch(/<script|onerror/i);
  });

  describe("rate limiting", () => {
    it("429 with Retry-After once the per-key limit is exceeded; other keys unaffected", async () => {
      vi.stubEnv("API_RATE_LIMIT_PER_MINUTE", "3");
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await post({ idem: `rl-${i}` })).status);
      expect(statuses).toEqual([202, 202, 202, 429, 429]);
      const limited = await post({ idem: "rl-x" });
      expect(limited.headers.get("retry-after")).toBeTruthy();
      expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
      expect((await post({ key: w.keys.a1Only, idem: "other" })).status).toBe(202);
    });
  });
});

describe("quota concurrency through the API", () => {
  it("never accepts more than the monthly limit under parallel requests", async () => {
    w.db.rows("workspaces").find((x) => x.id === w.ids.wsA)!.monthly_sending_limit = 3;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => post({ idem: `q-${i}`, body: valid({ to: `u${i}@x.example` }) })),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 202)).toHaveLength(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(9);
    expect(outbound()).toHaveLength(3);
    const usage = w.db.rows("monthly_usage").find((u) => u.year_month === currentYearMonth())!;
    expect(usage.reserved_count).toBe(3);
    // rejected requests left nothing behind and released their keys (safe to retry later)
    expect(w.db.rows("messages")).toHaveLength(3);
    expect(w.db.rows("api_idempotency_keys")).toHaveLength(3);
  });
});

describe("GET /api/v1/emails/[id]", () => {
  it("polls status through queued -> sent -> delivered", async () => {
    const { id } = await (await post({ idem: "poll-1" })).json();
    let res = await get(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, status: "queued", recipients: [{ address: "customer@customer.example", type: "to", status: "pending" }] });

    // worker tick with the MOCK provider: nothing leaves the process
    const adapter = MockEmailAdapter.createIsolated();
    const summary = await processOutboxBatch(w.admin, adapter, { workerId: "t" });
    expect(summary).toMatchObject({ claimed: 1, succeeded: 1 });
    res = await get(id);
    expect(await res.json()).toMatchObject({ id, status: "sent", error: null });

    // delivery webhook (signed) marks it delivered
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("RESEND_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
    const providerId = outbound()[0].resend_email_id as string;
    const ev = deliveryFixture(fixtures.delivered, providerId);
    const req = signedWebhook(ev, { eventId: "poll-evt" });
    const hook = await handleResendWebhook({ admin: w.admin, adapter, rawBody: req.rawBody, headers: req.headers, provider: "resend", account: "default" });
    expect(hook.status).toBe(200);
    expect(await (await get(id)).json()).toMatchObject({ status: "delivered", recipients: [{ status: "delivered" }] });
  });

  it("is workspace-scoped: another workspace's key (or a random id) gets 404", async () => {
    const { id } = await (await post()).json();
    expect((await get(id, w.keys.b)).status).toBe(404);
    expect((await get("00000000-0000-4000-8000-0000000000ff")).status).toBe(404);
    expect((await get("not-a-uuid")).status).toBe(404);
  });

  it("does not expose messages written by UI users or inbound mail", async () => {
    const inbound = w.db.seed("messages", { workspace_id: w.ids.wsA, mailbox_id: w.ids.mbA1, direction: "inbound", lifecycle_state: "received", from_address: "x@y.example", thread_id: "t" });
    const ui = w.db.seed("messages", { workspace_id: w.ids.wsA, mailbox_id: w.ids.mbA1, direction: "outbound", lifecycle_state: "queued", from_address: "support@a.example", thread_id: "t", author_user_id: w.users.sender });
    expect((await get(inbound.id as string)).status).toBe(404);
    expect((await get(ui.id as string)).status).toBe(404);
  });

  it("requires a valid key (401), including revoked and suspended", async () => {
    const { id } = await (await post()).json();
    expect((await get(id, w.keys.revoked)).status).toBe(401);
    w.db.rows("workspaces").find((x) => x.id === w.ids.wsA)!.status = "suspended";
    expect((await get(id)).status).toBe(401);
  });

  it("reports failures from the provider", async () => {
    const { id } = await (await post({ body: valid({ subject: "[mock-fail] nope" }) })).json();
    const adapter = MockEmailAdapter.createIsolated();
    await processOutboxBatch(w.admin, adapter, { workerId: "t" });
    const body = await (await get(id)).json();
    expect(body.status).toBe("failed");
    expect(body.error).toMatch(/Mock permanent failure/);
    // quota reservation released
    expect(w.db.rows("monthly_usage")[0]).toMatchObject({ reserved_count: 0, settled_count: 0 });
  });
});

describe("mock send path", () => {
  it("delivers via the mock adapter with a stable provider idempotency key and records usage", async () => {
    await post({ idem: "m1", body: valid({ to: ["a@x.example"], cc: ["b@x.example"], bcc: ["c@x.example"], reply_to: "replies@a.example" }) });
    const adapter = MockEmailAdapter.createIsolated();
    await processOutboxBatch(w.admin, adapter, { workerId: "w1" });
    const sent = adapter.getSentEmails();
    expect(sent).toHaveLength(1);
    expect(sent[0].input).toMatchObject({
      from: '"A Support" <support@a.example>',
      to: ["a@x.example"],
      cc: ["b@x.example"],
      bcc: ["c@x.example"],
      replyTo: ["replies@a.example"],
      subject: "Your receipt",
    });
    expect(sent[0].input.headers?.["Message-ID"]).toMatch(/@a\.example>$/);
    const job = w.db.rows("outbox_jobs")[0];
    expect(sent[0].idempotencyKey).toBe(`mc-outbox-${job.id}`);
    expect(outbound()[0]).toMatchObject({ lifecycle_state: "submitted", resend_email_id: sent[0].providerEmailId });
    expect(w.db.rows("monthly_usage")[0]).toMatchObject({ reserved_count: 0, settled_count: 3 });

    // a second tick finds nothing: no double send
    await processOutboxBatch(w.admin, adapter, { workerId: "w2" });
    expect(adapter.getSentEmails()).toHaveLength(1);
  });

  it("two workers racing never double-send a job", async () => {
    await post({ idem: "m2" });
    const adapter = MockEmailAdapter.createIsolated();
    await Promise.all([
      processOutboxBatch(w.admin, adapter, { workerId: "w1" }),
      processOutboxBatch(w.admin, adapter, { workerId: "w2" }),
      processOutboxBatch(w.admin, adapter, { workerId: "w3" }),
    ]);
    expect(adapter.getSentEmails()).toHaveLength(1);
  });

  it("suspension after queueing fails the job and releases quota (no send)", async () => {
    await post({ idem: "m3" });
    w.db.rows("workspaces").find((x) => x.id === w.ids.wsA)!.status = "suspended";
    const adapter = MockEmailAdapter.createIsolated();
    await processOutboxBatch(w.admin, adapter, { workerId: "w1" });
    expect(adapter.getSentEmails()).toHaveLength(0);
    expect(outbound()[0].lifecycle_state).toBe("failed");
    expect(w.db.rows("monthly_usage")[0]).toMatchObject({ reserved_count: 0, settled_count: 0 });
  });
});
