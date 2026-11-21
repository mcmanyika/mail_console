import { afterEach, describe, expect, it, vi } from "vitest";
import { MOCK_FAIL_MARKER, MOCK_TRANSIENT_MARKER, MockEmailAdapter } from "./mock";
import { getEmailAdapter, resetEmailAdapterCache, resolveEmailAdapterMode } from "./index";
import { WebhookVerificationError } from "./types";

afterEach(() => {
  vi.unstubAllEnvs();
  resetEmailAdapterCache();
});

describe("adapter selection", () => {
  it("uses the mock in DEMO_MODE even with an API key", () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("RESEND_API_KEY", "re_live_key");
    expect(resolveEmailAdapterMode()).toBe("mock");
    expect(getEmailAdapter().mode).toBe("mock");
  });
  it("uses the mock when the key is missing", () => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("RESEND_API_KEY", "");
    expect(resolveEmailAdapterMode()).toBe("mock");
  });
  it("uses live only when demo is off and a key exists", () => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    expect(resolveEmailAdapterMode()).toBe("live");
    expect(getEmailAdapter().mode).toBe("live");
  });
});

describe("MockEmailAdapter", () => {
  const input = { from: "a@x.example", to: ["b@y.example"], subject: "Hi", text: "t" };

  it("records sends without delivering, and dedupes on idempotency key", async () => {
    const m = MockEmailAdapter.createIsolated();
    const r1 = await m.sendEmail(input, { idempotencyKey: "k1" });
    const r2 = await m.sendEmail(input, { idempotencyKey: "k1" });
    expect(r1).toMatchObject({ ok: true });
    expect(r2).toEqual(r1);
    expect(m.getSentEmails()).toHaveLength(1);
  });

  it("simulates permanent and transient failures", async () => {
    const m = MockEmailAdapter.createIsolated();
    const perm = await m.sendEmail({ ...input, subject: `x ${MOCK_FAIL_MARKER}` }, { idempotencyKey: "p" });
    expect(perm).toMatchObject({ ok: false, error: { retryable: false } });
    const t1 = await m.sendEmail({ ...input, subject: `x ${MOCK_TRANSIENT_MARKER}` }, { idempotencyKey: "t" });
    const t2 = await m.sendEmail({ ...input, subject: `x ${MOCK_TRANSIENT_MARKER}` }, { idempotencyKey: "t" });
    expect(t1).toMatchObject({ ok: false, error: { retryable: true } });
    expect(t2).toMatchObject({ ok: true });
  });

  it("walks a domain through create -> verify", async () => {
    const m = MockEmailAdapter.createIsolated();
    const d = await m.createDomain({ hostname: "demo.example" });
    expect(d.status).toBe("pending");
    expect((await m.verifyDomain(d.providerDomainId)).status).toBe("verified");
  });

  it("parses webhooks and rejects garbage", () => {
    const m = MockEmailAdapter.createIsolated();
    const ev = m.verifyWebhook(JSON.stringify({ type: "email.delivered", data: { email_id: "e1" } }), new Headers({ "svix-id": "evt_1" }));
    expect(ev).toMatchObject({ eventId: "evt_1", type: "email.delivered", data: { email_id: "e1" } });
    expect(() => m.verifyWebhook("nope", new Headers())).toThrow(WebhookVerificationError);
  });
});
