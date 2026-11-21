import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// sanitize-html needs require(esm) (Node >= 20.19/22.12). Use the real module when it loads, a stub otherwise.
vi.mock("./sanitize", async (importOriginal) => {
  try {
    return await importOriginal<typeof import("./sanitize")>();
  } catch {
    return await import("../testing/sanitize-fallback");
  }
});

import { MockEmailAdapter } from "@/lib/resend/mock";
import { WebhookVerificationError } from "@/lib/resend/types";
import { seedWorld, type World } from "@/lib/testing/world";
import {
  FIXTURE_ATTACHMENT_BYTES,
  TEST_WEBHOOK_SECRET,
  deliveryFixture,
  demoWebhook,
  fixtures,
  receivedContent,
  signedWebhook,
} from "./fixtures";
import { MAX_WEBHOOK_ATTEMPTS, handleResendWebhook, reprocessWebhookEvents, verifyIncomingWebhook } from "./webhooks";

let w: World;
let adapter: MockEmailAdapter;

const rows = (t: string) => w.db.rows(t);
const inboundMessages = () => rows("messages").filter((m) => m.direction === "inbound");

function send(
  req: { rawBody: string; headers: Headers },
) {
  return handleResendWebhook({ admin: w.admin, adapter, rawBody: req.rawBody, headers: req.headers, provider: "resend", account: "default" });
}

function injectAll() {
  for (const id of ["recv_fixture_0001", "recv_fixture_0002", "recv_fixture_0003", "recv_fixture_0004"]) {
    adapter.injectReceivedEmail(receivedContent(id), id === "recv_fixture_0001" ? { att_fixture_1: { filename: "receipt.pdf", contentType: "application/pdf", data: FIXTURE_ATTACHMENT_BYTES } } : {});
  }
}

beforeEach(() => {
  w = seedWorld();
  adapter = MockEmailAdapter.createIsolated();
  injectAll();
  vi.stubEnv("DEMO_MODE", "false");
  vi.stubEnv("RESEND_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
});
afterEach(() => vi.unstubAllEnvs());

describe("signature verification", () => {
  it("accepts a correctly signed raw body", async () => {
    const res = await send(signedWebhook(fixtures.received, { eventId: "msg_sig_ok" }));
    expect(res.status).toBe(200);
    expect(inboundMessages()).toHaveLength(1);
  });

  it("rejects a tampered body, wrong secret, and missing headers — and persists nothing", async () => {
    const good = signedWebhook(fixtures.received, { eventId: "msg_sig_bad" });
    const tampered = await send({ ...good, rawBody: good.rawBody.replace("Question", "Quest1on") });
    expect(tampered.status).toBe(400);

    const wrongSecret = await send(signedWebhook(fixtures.received, { eventId: "msg_sig_bad2", secret: "whsec_" + Buffer.from("another-secret-another-secret!!").toString("base64") }));
    expect(wrongSecret.status).toBe(400);

    const unsigned = await send({ rawBody: good.rawBody, headers: new Headers() });
    expect(unsigned.status).toBe(400);

    expect(rows("webhook_events")).toHaveLength(0);
    expect(rows("messages")).toHaveLength(0);
  });

  it("rejects stale timestamps (replay protection)", async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const res = await send(signedWebhook(fixtures.received, { eventId: "msg_old", timestamp: old }));
    expect(res.status).toBe(400);
  });

  it("fails closed with 503 when no secret is configured", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
    const res = await send(signedWebhook(fixtures.received, { eventId: "msg_nosecret" }));
    expect(res.status).toBe(503);
    expect(rows("webhook_events")).toHaveLength(0);
  });

  it("accepts unsigned fixtures ONLY in DEMO_MODE with X-Mail-Console-Demo: 1", async () => {
    // demo off: header is ignored => unsigned request is rejected
    const off = await send(demoWebhook(fixtures.received, "evt_demo_off"));
    expect(off.status).toBe(400);

    vi.stubEnv("DEMO_MODE", "true");
    const on = await send(demoWebhook(fixtures.received, "evt_demo_on"));
    expect(on.status).toBe(200);
    expect(inboundMessages()).toHaveLength(1);

    // demo on but header missing => still requires a signature
    const noHeader = demoWebhook(fixtures.received, "evt_demo_nohdr");
    noHeader.headers.delete("x-mail-console-demo");
    expect((await send(noHeader)).status).toBe(400);
  });

  it("verifyIncomingWebhook throws WebhookVerificationError for bad signatures", () => {
    const good = signedWebhook(fixtures.received, { eventId: "msg_v" });
    expect(() => verifyIncomingWebhook(good.rawBody + " ", good.headers)).toThrow(WebhookVerificationError);
  });
});

describe("idempotent intake", () => {
  it("persists a duplicate delivery once and produces exactly one message", async () => {
    const req = signedWebhook(fixtures.received, { eventId: "msg_dupe" });
    const first = await send(req);
    const second = await send(req);
    const third = await send(signedWebhook(fixtures.received, { eventId: "msg_dupe" })); // re-signed redelivery, same event id

    expect(first.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, duplicate: true });
    expect(third.body).toMatchObject({ ok: true, duplicate: true });
    expect(rows("webhook_events")).toHaveLength(1);
    expect(rows("webhook_events")[0]).toMatchObject({ event_id: "msg_dupe", status: "processed", provider: "resend" });
    expect(inboundMessages()).toHaveLength(1);
    expect(rows("threads")).toHaveLength(1);
    expect(rows("attachments")).toHaveLength(1);
  });

  it("concurrent deliveries of the same event do not double-process", async () => {
    const reqs = Array.from({ length: 5 }, () => signedWebhook(fixtures.received, { eventId: "msg_race" }));
    const results = await Promise.all(reqs.map(send));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(rows("webhook_events")).toHaveLength(1);
    expect(inboundMessages()).toHaveLength(1);
    expect(rows("threads")).toHaveLength(1);
  });

  it("acknowledges only after durable intake: intake failure => not acked", async () => {
    const failing = w.admin;
    const original = failing.from.bind(failing);
    vi.spyOn(failing, "from").mockImplementation(((table: string) => {
      if (table === "webhook_events") throw new Error("db down");
      return original(table as never);
    }) as never);
    await expect(send(signedWebhook(fixtures.received, { eventId: "msg_dbdown" }))).rejects.toThrow("db down");
  });

  it("processing failure answers 500 (provider retries) and a retry completes without duplicates", async () => {
    const flaky = MockEmailAdapter.createIsolated(); // content not available yet
    const req = signedWebhook(fixtures.received, { eventId: "msg_flaky" });
    const res1 = await handleResendWebhook({ admin: w.admin, adapter: flaky, rawBody: req.rawBody, headers: req.headers, provider: "resend", account: "default" });
    expect(res1.status).toBe(500);
    expect(rows("webhook_events")[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(inboundMessages()).toHaveLength(0);

    const res2 = await send(req); // provider redelivery, content now available
    expect(res2.status).toBe(200);
    expect(rows("webhook_events")[0]).toMatchObject({ status: "processed", attempts: 2 });
    expect(inboundMessages()).toHaveLength(1);
  });

  it("gives up after MAX attempts (200, parked as failed for ops)", async () => {
    const empty = MockEmailAdapter.createIsolated();
    const req = signedWebhook(fixtures.received, { eventId: "msg_giveup" });
    let last = 0;
    for (let i = 0; i < MAX_WEBHOOK_ATTEMPTS; i++) {
      last = (await handleResendWebhook({ admin: w.admin, adapter: empty, rawBody: req.rawBody, headers: req.headers, provider: "resend", account: "default" })).status;
    }
    expect(last).toBe(200);
    expect(rows("webhook_events")[0]).toMatchObject({ status: "failed", attempts: MAX_WEBHOOK_ATTEMPTS });
    const again = await send(req);
    expect(again.body).toMatchObject({ status: "failed_permanently" });
  });

  it("cron reprocessing recovers events that were durably recorded but never finished", async () => {
    w.db.seed("webhook_events", {
      provider: "resend",
      provider_account: "default",
      event_id: "msg_stuck",
      event_type: "email.received",
      payload: fixtures.received,
      status: "received",
      received_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const summary = await reprocessWebhookEvents(w.admin, adapter);
    expect(summary.processed).toBe(1);
    expect(inboundMessages()).toHaveLength(1);
  });
});

describe("inbound routing isolation", () => {
  it("routes only by provider-supplied recipients; sender-controlled headers never select a workspace", async () => {
    const res = await send(signedWebhook(fixtures.receivedSpoofedHeaders, { eventId: "msg_spoof" }));
    expect(res.status).toBe(200);
    const msgs = inboundMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].workspace_id).toBe(w.ids.wsA);
    expect(msgs[0].mailbox_id).toBe(w.ids.mbA1);
    expect(msgs.some((m) => m.workspace_id === w.ids.wsB)).toBe(false);
  });

  it("creates separately scoped records for each known mailbox (even across workspaces)", async () => {
    const res = await send(signedWebhook(fixtures.receivedMulti, { eventId: "msg_multi" }));
    expect(res.status).toBe(200);
    const msgs = inboundMessages();
    expect(msgs).toHaveLength(3);
    const byMailbox = new Map(msgs.map((m) => [m.mailbox_id, m]));
    expect([...byMailbox.keys()].sort()).toEqual([w.ids.mbA1, w.ids.mbA2, w.ids.mbB1].sort());

    // each message sits in a thread of ITS OWN mailbox/workspace; ids are never shared
    const threads = rows("threads");
    expect(threads).toHaveLength(3);
    for (const m of msgs) {
      const t = threads.find((x) => x.id === m.thread_id)!;
      expect(t.mailbox_id).toBe(m.mailbox_id);
      expect(t.workspace_id).toBe(m.workspace_id);
    }
    expect(new Set(msgs.map((m) => m.id)).size).toBe(3);
    expect(byMailbox.get(w.ids.mbB1)!.workspace_id).toBe(w.ids.wsB);
    // recipients rows are scoped to their own message/workspace
    for (const r of rows("message_recipients")) {
      const m = msgs.find((x) => x.id === r.message_id)!;
      expect(r.workspace_id).toBe(m.workspace_id);
    }
  });

  it("stores unmatched events for ops review without creating any message content", async () => {
    const res = await send(signedWebhook(fixtures.receivedUnmatched, { eventId: "msg_unmatched" }));
    expect(res.status).toBe(200);
    expect(rows("messages")).toHaveLength(0);
    expect(rows("threads")).toHaveLength(0);
    expect(rows("webhook_events")[0]).toMatchObject({ status: "ignored", error: "unmatched: no_known_recipient" });
    // and no content was even fetched from the provider
    expect(rows("attachments")).toHaveLength(0);
  });

  it("ignores disabled mailboxes", async () => {
    w.db.rows("mailboxes").find((m) => m.id === w.ids.mbA1)!.enabled = false;
    await send(signedWebhook(fixtures.received, { eventId: "msg_disabled" }));
    expect(rows("messages")).toHaveLength(0);
    expect(rows("webhook_events")[0].status).toBe("ignored");
  });

  it("falls back to the base mailbox for +tag sub-addresses", async () => {
    const e = structuredClone(fixtures.received);
    e.data.to = ["support+billing@a.example"];
    await send(signedWebhook(e, { eventId: "msg_plus" }));
    expect(inboundMessages().map((m) => m.mailbox_id)).toEqual([w.ids.mbA1]);
  });

  it("honours received_for exclusively when the provider supplies it", async () => {
    const e = structuredClone(fixtures.receivedMulti);
    e.data.received_for = ["hello@a.example"];
    await send(signedWebhook(e, { eventId: "msg_rf" }));
    expect(inboundMessages().map((m) => m.mailbox_id)).toEqual([w.ids.mbA2]);
  });

  it("still receives inbound mail for a suspended workspace", async () => {
    w.db.rows("workspaces").find((x) => x.id === w.ids.wsA)!.status = "suspended";
    const res = await send(signedWebhook(fixtures.received, { eventId: "msg_susp" }));
    expect(res.status).toBe(200);
    expect(inboundMessages()).toHaveLength(1);
  });
});

describe("inbound content handling", () => {
  it("sanitises HTML, blocks remote images, and stores attachments in the private bucket with a safe name", async () => {
    await send(signedWebhook(fixtures.received, { eventId: "msg_content" }));
    const m = inboundMessages()[0];
    expect(m.html_body).toBeTypeOf("string");
    const html = m.html_body as string;
    expect(html).not.toMatch(/<script|onclick|javascript:|alert\(/i);
    expect(html).not.toMatch(/\ssrc="https?:\/\/tracker/i);
    expect(html).toContain("data-blocked-src");
    expect(m.text_body).toBe("Hi, where is my order?");
    expect(m.lifecycle_state).toBe("received");
    expect(m.rfc_message_id).toBe("<orig-0001@customer.example>");

    const [att] = rows("attachments");
    expect(att.filename).toBe("receipt.pdf"); // path traversal stripped
    expect(att.workspace_id).toBe(w.ids.wsA);
    expect(String(att.storage_path).startsWith(`${w.ids.wsA}/${m.id}/`)).toBe(true);
    expect(String(att.storage_path)).not.toContain("..");
    const key = `attachments/${att.storage_path}`;
    expect(w.db.objects.get(key)?.data).toEqual(FIXTURE_ATTACHMENT_BYTES);
  });
});

describe("inbound threading", () => {
  it("threads replies by In-Reply-To/References inside the mailbox, new thread otherwise", async () => {
    await send(signedWebhook(fixtures.received, { eventId: "msg_t1" }));
    const first = inboundMessages()[0];

    const reply = structuredClone(fixtures.received);
    reply.data.email_id = "recv_thread_reply";
    reply.data.message_id = "<reply-1@customer.example>";
    adapter.injectReceivedEmail({
      ...receivedContent("recv_fixture_0001"),
      providerEmailId: "recv_thread_reply",
      subject: "Totally different subject",
      messageId: "<reply-1@customer.example>",
      headers: { "message-id": "<reply-1@customer.example>", "in-reply-to": "<orig-0001@customer.example>", references: "<orig-0001@customer.example>" },
      attachments: [],
    });
    await send(signedWebhook(reply, { eventId: "msg_t2" }));

    // unrelated message with a "Re:" subject but no matching headers: must NOT join the thread
    const lookalike = structuredClone(fixtures.received);
    lookalike.data.email_id = "recv_thread_lookalike";
    lookalike.data.message_id = "<look@customer.example>";
    adapter.injectReceivedEmail({
      ...receivedContent("recv_fixture_0001"),
      providerEmailId: "recv_thread_lookalike",
      subject: "Re: Question about my order",
      messageId: "<look@customer.example>",
      headers: { "message-id": "<look@customer.example>" },
      attachments: [],
    });
    await send(signedWebhook(lookalike, { eventId: "msg_t3" }));

    const msgs = inboundMessages();
    expect(msgs).toHaveLength(3);
    const byProv = (id: string) => msgs.find((m) => m.resend_email_id === id)!;
    expect(byProv("recv_thread_reply").thread_id).toBe(first.thread_id);
    expect(byProv("recv_thread_lookalike").thread_id).not.toBe(first.thread_id);
    expect(rows("threads")).toHaveLength(2);
  });

  it("never threads across mailboxes: a reply to a message another mailbox holds starts its own thread", async () => {
    await send(signedWebhook(fixtures.receivedMulti, { eventId: "msg_x1" }));
    const a1 = inboundMessages().find((m) => m.mailbox_id === w.ids.mbA1)!;

    // reply addressed ONLY to B's mailbox but referencing the Message-ID that A1 also stores
    const e = structuredClone(fixtures.receivedMulti);
    e.data.email_id = "recv_x_reply";
    e.data.to = ["support@b.example"];
    e.data.cc = [];
    adapter.injectReceivedEmail({
      ...receivedContent("recv_fixture_0002"),
      providerEmailId: "recv_x_reply",
      to: ["support@b.example"],
      cc: [],
      messageId: "<xr@partner.example>",
      headers: { "message-id": "<xr@partner.example>", "in-reply-to": "<multi-0002@partner.example>" },
    });
    await send(signedWebhook(e, { eventId: "msg_x2" }));
    const reply = inboundMessages().find((m) => m.resend_email_id === "recv_x_reply")!;
    const bOriginal = inboundMessages().find((m) => m.mailbox_id === w.ids.mbB1 && m.resend_email_id === "recv_fixture_0002")!;
    expect(reply.mailbox_id).toBe(w.ids.mbB1);
    expect(reply.thread_id).toBe(bOriginal.thread_id); // joins B's own copy…
    expect(reply.thread_id).not.toBe(a1.thread_id); // …never A's
  });

  it("new mail resurfaces an archived thread for users", async () => {
    await send(signedWebhook(fixtures.received, { eventId: "msg_r1" }));
    const first = inboundMessages()[0];
    w.db.seed("thread_user_state", { workspace_id: w.ids.wsA, thread_id: first.thread_id, user_id: w.users.sender, is_read: true, is_archived: true });
    adapter.injectReceivedEmail({
      ...receivedContent("recv_fixture_0001"),
      providerEmailId: "recv_r2",
      messageId: "<r2@customer.example>",
      headers: { "message-id": "<r2@customer.example>", "in-reply-to": "<orig-0001@customer.example>" },
      attachments: [],
    });
    const e = structuredClone(fixtures.received);
    e.data.email_id = "recv_r2";
    await send(signedWebhook(e, { eventId: "msg_r2" }));
    expect(rows("thread_user_state")[0]).toMatchObject({ is_read: false, is_archived: false });
  });
});

describe("delivery events: duplicate / out-of-order safe", () => {
  async function outboundWithRecipient() {
    const draft = w.db.seed("messages", {
      workspace_id: w.ids.wsA,
      mailbox_id: w.ids.mbA1,
      direction: "outbound",
      lifecycle_state: "submitted",
      thread_id: w.db.seed("threads", { workspace_id: w.ids.wsA, mailbox_id: w.ids.mbA1 }).id,
      from_address: "support@a.example",
      subject: "Re: Question",
      resend_email_id: "prov_out_1",
    });
    w.db.seed("message_recipients", { message_id: draft.id, workspace_id: w.ids.wsA, address: "customer@customer.example", type: "to", delivery_state: "sent" });
    w.db.seed("message_recipients", { message_id: draft.id, workspace_id: w.ids.wsA, address: "other@customer.example", type: "cc", delivery_state: "sent" });
    return draft;
  }
  const state = (address: string) => rows("message_recipients").find((r) => r.address === address)!.delivery_state;

  it("advances sent -> delivered and is a no-op on duplicates", async () => {
    await outboundWithRecipient();
    const ev = deliveryFixture(fixtures.delivered, "prov_out_1");
    expect((await send(signedWebhook(ev, { eventId: "d1" }))).status).toBe(200);
    expect(state("customer@customer.example")).toBe("delivered");
    expect(state("other@customer.example")).toBe("sent"); // only the addressed recipient changed
    expect((await send(signedWebhook(ev, { eventId: "d1" }))).body).toMatchObject({ duplicate: true });
    // a *new* event id carrying the same state changes nothing either
    expect((await send(signedWebhook(ev, { eventId: "d1b" }))).status).toBe(200);
    expect(state("customer@customer.example")).toBe("delivered");
  });

  it("never regresses: bounced arrives first, a late 'delivered' / 'delayed' is ignored", async () => {
    await outboundWithRecipient();
    await send(signedWebhook(deliveryFixture(fixtures.bounced, "prov_out_1"), { eventId: "b1" }));
    expect(state("customer@customer.example")).toBe("bounced");
    await send(signedWebhook(deliveryFixture(fixtures.delivered, "prov_out_1"), { eventId: "late_delivered" }));
    await send(signedWebhook(deliveryFixture(fixtures.delayed, "prov_out_1"), { eventId: "late_delayed" }));
    expect(state("customer@customer.example")).toBe("bounced");
  });

  it("allows forward progress: delayed -> delivered -> complained", async () => {
    await outboundWithRecipient();
    await send(signedWebhook(deliveryFixture(fixtures.delayed, "prov_out_1"), { eventId: "p1" }));
    expect(state("customer@customer.example")).toBe("delayed");
    await send(signedWebhook(deliveryFixture(fixtures.delivered, "prov_out_1"), { eventId: "p2" }));
    expect(state("customer@customer.example")).toBe("delivered");
    const complained = deliveryFixture({ ...fixtures.delivered, type: "email.complained" }, "prov_out_1");
    await send(signedWebhook(complained, { eventId: "p3" }));
    expect(state("customer@customer.example")).toBe("complained");
  });

  it("retries a delivery event that beat our own bookkeeping, then parks it after max attempts", async () => {
    const ev = deliveryFixture(fixtures.delivered, "prov_unknown");
    const res = await send(signedWebhook(ev, { eventId: "orphan" }));
    expect(res.status).toBe(500);
    expect(rows("webhook_events")[0]).toMatchObject({ status: "failed", error: "message_not_found" });

    await outboundWithRecipient();
    w.db.rows("messages").find((m) => m.resend_email_id === "prov_out_1")!.resend_email_id = "prov_unknown";
    const retried = await send(signedWebhook(ev, { eventId: "orphan" }));
    expect(retried.status).toBe(200);
    expect(state("customer@customer.example")).toBe("delivered");
  });
});
