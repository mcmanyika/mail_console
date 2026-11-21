import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email/sanitize", async (importOriginal) => {
  try {
    return await importOriginal<typeof import("@/lib/email/sanitize")>();
  } catch {
    return await import("@/lib/testing/sanitize-fallback");
  }
});

const holder = vi.hoisted(() => ({ admin: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => holder.admin }));

import { GET as cronGet, POST as cronPost } from "@/app/api/cron/outbox/route";
import { POST as webhookPost } from "@/app/api/webhooks/resend/route";
import { demoWebhook, fixtures, receivedContent, signedWebhook, TEST_WEBHOOK_SECRET } from "@/lib/email/fixtures";
import { enqueueOutboundMessage } from "@/lib/email/outbox";
import { getEmailAdapter, resetEmailAdapterCache } from "@/lib/resend";
import { MockEmailAdapter } from "@/lib/resend/mock";
import { seedWorld, type World } from "@/lib/testing/world";
import { isPublicPath } from "@/lib/routes";

let w: World;
beforeEach(() => {
  w = seedWorld();
  holder.admin = w.admin;
  resetEmailAdapterCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEmailAdapterCache();
});

const cron = (method: "GET" | "POST", token?: string) =>
  (method === "GET" ? cronGet : cronPost)(
    new Request("http://localhost/api/cron/outbox", { method, headers: token ? { authorization: `Bearer ${token}` } : {} }),
  );

describe("proxy.ts public-path rules cover the machine endpoints", () => {
  it("lets webhooks, v1 API and cron through without a session", () => {
    for (const p of ["/api/webhooks/resend", "/api/v1/emails", "/api/v1/emails/abc", "/api/cron/outbox"]) expect(isPublicPath(p)).toBe(true);
    expect(isPublicPath("/api/internal/anything")).toBe(false);
  });
});

describe("POST|GET /api/cron/outbox", () => {
  it("fails closed (503) when CRON_SECRET is unset, never treating that as open", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await cron("GET")).status).toBe(503);
    expect((await cron("GET", "")).status).toBe(503);
  });

  it("401 for a missing or wrong bearer token", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret-s3cret-s3cret");
    expect((await cron("POST")).status).toBe(401);
    expect((await cron("POST", "wrong")).status).toBe(401);
    expect((await cron("GET", "s3cret-s3cret-s3cret-extra")).status).toBe(401);
  });

  it("claims and processes queued jobs with the mock adapter (GET for Vercel Cron, POST for others)", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret-s3cret-s3cret");
    for (const [i, method] of (["GET", "POST"] as const).entries()) {
      const id = w.db.seed("messages", {
        workspace_id: w.ids.wsA, mailbox_id: w.ids.mbA1, direction: "draft", lifecycle_state: "draft",
        from_address: "support@a.example", subject: `cron ${i}`, text_body: "hi", author_user_id: w.users.sender,
      }).id as string;
      w.db.seed("message_recipients", { message_id: id, workspace_id: w.ids.wsA, address: `r${i}@x.example`, type: "to" });
      await enqueueOutboundMessage(w.admin, { messageId: id, idempotencyKey: `cron-${i}`, recipients: { to: [`r${i}@x.example`] } });

      const res = await cron(method, "s3cret-s3cret-s3cret");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, adapter: "mock", outbox: { claimed: 1, succeeded: 1 } });
      expect(w.db.rows("messages").find((m) => m.id === id)!.lifecycle_state).toBe("submitted");
    }
    expect((getEmailAdapter() as MockEmailAdapter).getSentEmails().length).toBeGreaterThanOrEqual(2);
  });

  it("is a harmless no-op on an empty queue", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret-s3cret-s3cret");
    const res = await cron("GET", "s3cret-s3cret-s3cret");
    expect((await res.json()).outbox).toMatchObject({ claimed: 0, ticks: 1 });
  });
});

describe("POST /api/webhooks/resend (route handler)", () => {
  const post = (req: { rawBody: string; headers: Headers }) =>
    webhookPost(new Request("http://localhost/api/webhooks/resend", { method: "POST", headers: req.headers, body: req.rawBody }));

  it("400 on a bad signature, 200 on a good one — verified against the raw body", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("RESEND_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
    const good = signedWebhook(fixtures.receivedUnmatched, { eventId: "route_1" });
    // pretty-printed JSON is semantically identical but byte-different => must fail
    const reformatted = { ...good, rawBody: JSON.stringify(JSON.parse(good.rawBody), null, 2) };
    expect((await post(reformatted)).status).toBe(400);
    expect((await post(good)).status).toBe(200);
    expect(w.db.rows("webhook_events")).toHaveLength(1);
  });

  it("DEMO_MODE: unsigned fixture with the demo header ingests an inbound email end-to-end via the mock provider", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    (getEmailAdapter() as MockEmailAdapter).injectReceivedEmail(receivedContent("recv_fixture_0002"));
    const res = await post(demoWebhook(fixtures.receivedMulti, "route_demo_1"));
    expect(res.status).toBe(200);
    expect(w.db.rows("messages").filter((m) => m.direction === "inbound")).toHaveLength(3);
  });

  it("DEMO_MODE with inline content: works without pre-seeding the mock provider", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const e = structuredClone(fixtures.received);
    e.data = { ...e.data, attachments: [], text: "inline demo body", html: "<p>inline demo body</p>" };
    const res = await post(demoWebhook(e, "route_demo_2"));
    expect(res.status).toBe(200);
    expect(w.db.rows("messages").find((m) => m.direction === "inbound")).toMatchObject({ text_body: "inline demo body" });
  });

  it("rejects oversized payloads with 413 before parsing", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const res = await post({ rawBody: JSON.stringify({ type: "x", pad: "x".repeat(1_100_000) }), headers: new Headers({ "x-mail-console-demo": "1" }) });
    expect(res.status).toBe(413);
    expect(w.db.rows("webhook_events")).toHaveLength(0);
  });
});
