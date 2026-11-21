import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email/sanitize", async (importOriginal) => {
  try {
    return await importOriginal<typeof import("@/lib/email/sanitize")>();
  } catch {
    return await import("@/lib/testing/sanitize-fallback");
  }
});

import { AuthzError } from "@/lib/auth/authz";
import { fixtures, receivedContent, FIXTURE_ATTACHMENT_BYTES, signedWebhook, TEST_WEBHOOK_SECRET } from "@/lib/email/fixtures";
import { processOutboxBatch } from "@/lib/email/outbox";
import { handleResendWebhook } from "@/lib/email/webhooks";
import { MockEmailAdapter } from "@/lib/resend/mock";
import { seedWorld, type World } from "@/lib/testing/world";
import {
  composeAndSend,
  computeReplyRecipients,
  forwardMessage,
  getAttachmentSignedUrl,
  markThreadUnread,
  replyToMessage,
  saveDraft,
  sendDraft,
  setThreadState,
  archiveThread,
  discardDraft,
  InboxError,
  type InboxCtx,
} from "./inbox";

let w: World;
let adapter: MockEmailAdapter;
const ctxFor = (userId: string): InboxCtx => ({ admin: w.admin, userId });

async function receiveFixture(emailId = "recv_fixture_0001", eventId = `evt_${emailId}`) {
  vi.stubEnv("DEMO_MODE", "false");
  vi.stubEnv("RESEND_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
  adapter.injectReceivedEmail(receivedContent(emailId), emailId === "recv_fixture_0001" ? { att_fixture_1: { filename: "receipt.pdf", contentType: "application/pdf", data: FIXTURE_ATTACHMENT_BYTES } } : {});
  const ev = emailId === "recv_fixture_0001" ? fixtures.received : fixtures.receivedMulti;
  const req = signedWebhook(ev, { eventId });
  const res = await handleResendWebhook({ admin: w.admin, adapter, rawBody: req.rawBody, headers: req.headers, provider: "resend", account: "default" });
  expect(res.status).toBe(200);
  vi.unstubAllEnvs();
  return w.db.rows("messages").filter((m) => m.direction === "inbound" && m.resend_email_id === emailId);
}

beforeEach(() => {
  w = seedWorld();
  adapter = MockEmailAdapter.createIsolated();
});

describe("reply threading headers", () => {
  it("sets In-Reply-To / References from the parent and keeps the thread, via the mock provider", async () => {
    const [parent] = await receiveFixture();
    const sender = ctxFor(w.users.sender);

    const { sent } = await replyToMessage(sender, { messageId: parent.id as string, text: "On it!" });
    expect(sent).toMatchObject({ status: "queued", threadId: parent.thread_id });

    const msg = w.db.rows("messages").find((m) => m.id === sent!.messageId)!;
    expect(msg).toMatchObject({
      direction: "outbound",
      thread_id: parent.thread_id,
      in_reply_to: "<orig-0001@customer.example>",
      references_header: "<orig-0001@customer.example>",
      subject: "Re: Question about my order",
    });

    await processOutboxBatch(w.admin, adapter, { workerId: "t" });
    const [out] = adapter.getSentEmails();
    expect(out.input.from).toBe('"A Support" <support@a.example>');
    expect(out.input.to).toEqual(["alice@customer.example"]);
    expect(out.input.headers).toMatchObject({
      "In-Reply-To": "<orig-0001@customer.example>",
      References: "<orig-0001@customer.example>",
    });
    expect(out.input.headers?.["Message-ID"]).toMatch(/^<.+@a\.example>$/);
    expect(out.input.text).toContain("On it!");
    expect(out.input.text).toContain("> Hi, where is my order?"); // quoted original

    // a reply to OUR reply extends the References chain
    const replyOut = w.db.rows("messages").find((m) => m.id === sent!.messageId)!;
    const second = await replyToMessage(sender, { messageId: replyOut.id as string, text: "Follow-up", includeQuote: false });
    const m2 = w.db.rows("messages").find((m) => m.id === second.sent!.messageId)!;
    expect(m2.in_reply_to).toBe(replyOut.rfc_message_id);
    expect(m2.references_header).toBe(`<orig-0001@customer.example> ${replyOut.rfc_message_id}`);
    expect(m2.thread_id).toBe(parent.thread_id);
  });

  it("reply-all excludes our own address and de-duplicates", () => {
    const rec = computeReplyRecipients(
      { direction: "inbound", from_address: "Bob <bob@p.example>", reply_to: null },
      { to: ["support@a.example", "carol@p.example"], cc: ["dave@p.example", "bob@p.example"], bcc: [] },
      "support@a.example",
      true,
    );
    expect(rec).toEqual({ to: ["bob@p.example"], cc: ["carol@p.example", "dave@p.example"], bcc: [] });
  });

  it("prefers Reply-To for the reply target", () => {
    const rec = computeReplyRecipients(
      { direction: "inbound", from_address: "News <no-reply@p.example>", reply_to: "help@p.example" },
      { to: [], cc: [], bcc: [] },
      "support@a.example",
      false,
    );
    expect(rec.to).toEqual(["help@p.example"]);
  });
});

describe("access control (requireMailboxAccess on every action)", () => {
  it("read-only users cannot send, reply, forward or save drafts", async () => {
    const [parent] = await receiveFixture();
    const reader = ctxFor(w.users.reader);
    const input = { mailboxId: w.ids.mbA1, to: ["x@x.example"], subject: "s", text: "t" };
    await expect(composeAndSend(reader, input)).rejects.toMatchObject({ status: 403 });
    await expect(saveDraft(reader, input)).rejects.toMatchObject({ status: 403 });
    await expect(replyToMessage(reader, { messageId: parent.id as string, text: "x" })).rejects.toMatchObject({ status: 403 });
    await expect(forwardMessage(reader, { messageId: parent.id as string, to: ["x@x.example"] })).rejects.toMatchObject({ status: 403 });
    expect(w.db.rows("messages").filter((m) => m.direction !== "inbound")).toHaveLength(0);
  });

  it("a workspace OWNER without a mailbox grant and a user from another workspace get 404, never content", async () => {
    const [parent] = await receiveFixture();
    for (const user of [w.users.noGrant, w.users.outsider, w.users.platformAdmin]) {
      const ctx = ctxFor(user);
      await expect(replyToMessage(ctx, { messageId: parent.id as string, text: "x" })).rejects.toMatchObject({ status: 404 });
      await expect(setThreadState(ctx, { threadId: parent.thread_id as string, read: true })).rejects.toMatchObject({ status: 404 });
      await expect(composeAndSend(ctx, { mailboxId: w.ids.mbA1, to: ["x@x.example"], subject: "s", text: "t" })).rejects.toBeInstanceOf(AuthzError);
      const att = w.db.rows("attachments")[0];
      await expect(getAttachmentSignedUrl(ctx, att.id as string)).rejects.toMatchObject({ status: 404 });
    }
  });

  it("a sender cannot use a mailbox they only have read on (A2) or one outside their workspace (B1)", async () => {
    const sender = ctxFor(w.users.sender);
    await expect(composeAndSend(sender, { mailboxId: w.ids.mbA2, to: ["x@x.example"], subject: "s", text: "t" })).rejects.toMatchObject({ status: 403 });
    await expect(composeAndSend(sender, { mailboxId: w.ids.mbB1, to: ["x@x.example"], subject: "s", text: "t" })).rejects.toMatchObject({ status: 404 });
  });

  it("forwarding requires send access on the destination mailbox and the same workspace", async () => {
    const [parent] = await receiveFixture();
    const sender = ctxFor(w.users.sender);
    await expect(forwardMessage(sender, { messageId: parent.id as string, mailboxId: w.ids.mbA2, to: ["x@x.example"] })).rejects.toMatchObject({ status: 403 });
    await expect(forwardMessage(sender, { messageId: parent.id as string, mailboxId: w.ids.mbB1, to: ["x@x.example"] })).rejects.toMatchObject({ status: 404 });
  });
});

describe("compose / drafts / send", () => {
  const input = () => ({ mailboxId: w.ids.mbA1, to: ["Customer@Example.com"], subject: "Hello", text: "Body text" });

  it("resolves From server-side from the approved mailbox; there is no way to pass one", async () => {
    const sender = ctxFor(w.users.sender);
    const spoof = { ...input(), from: "ceo@a.example", fromAddress: "ceo@a.example" } as never;
    const out = await composeAndSend(sender, spoof);
    const msg = w.db.rows("messages").find((m) => m.id === out.messageId)!;
    expect(msg.from_address).toBe('"A Support" <support@a.example>');
    expect(msg).toMatchObject({ direction: "outbound", author_user_id: w.users.sender, thread_id: out.threadId });
    expect(w.db.rows("message_recipients").map((r) => r.address)).toEqual(["customer@example.com"]);
  });

  it("drafts are private to their author", async () => {
    const author = ctxFor(w.users.sender);
    const { draftId } = await saveDraft(author, input());
    // a colleague with the SAME mailbox grants (reader has read only; give them send) still cannot touch it
    w.db.rows("mailbox_access").find((g) => g.membership_id === w.db.rows("workspace_memberships").find((m) => m.user_id === w.users.reader)!.id)!.permission = "read_send";
    const colleague = ctxFor(w.users.reader);
    await expect(sendDraft(colleague, draftId)).rejects.toMatchObject({ status: 404 });
    await expect(discardDraft(colleague, draftId)).rejects.toMatchObject({ status: 404 });
    await expect(saveDraft(colleague, { ...input(), draftId })).rejects.toMatchObject({ status: 404 });
    expect(w.db.rows("messages").find((m) => m.id === draftId)).toMatchObject({ direction: "draft", author_user_id: w.users.sender });
  });

  it("updates a draft in place, then sends it once even if send is clicked twice", async () => {
    const sender = ctxFor(w.users.sender);
    const { draftId } = await saveDraft(sender, input());
    const again = await saveDraft(sender, { ...input(), draftId, subject: "Hello v2", to: ["a@x.example", "b@x.example"] });
    expect(again.draftId).toBe(draftId);
    expect(w.db.rows("message_recipients").map((r) => r.address).sort()).toEqual(["a@x.example", "b@x.example"]);

    const [one, two] = await Promise.all([sendDraft(sender, draftId), sendDraft(sender, draftId)]);
    expect(one.messageId).toBe(draftId);
    expect(two.messageId).toBe(draftId);
    expect(w.db.rows("outbox_jobs")).toHaveLength(1);
    expect(w.db.rows("monthly_usage")[0].reserved_count).toBe(2);
  });

  it("validates recipients and requires a body + verified domain to send", async () => {
    const sender = ctxFor(w.users.sender);
    await expect(composeAndSend(sender, { ...input(), to: ["nope"] })).rejects.toMatchObject({ code: "invalid_recipient" });
    await expect(composeAndSend(sender, { ...input(), to: [] })).rejects.toMatchObject({ code: "invalid_recipient" });
    await expect(composeAndSend(sender, { ...input(), text: "  " })).rejects.toMatchObject({ code: "invalid_content" });
    w.db.rows("domains")[0].send_status = "pending";
    await expect(composeAndSend(sender, input())).rejects.toMatchObject({ code: "sender_not_verified" });
  });

  it("enforces the monthly quota and reports it", async () => {
    w.db.rows("workspaces").find((x) => x.id === w.ids.wsA)!.monthly_sending_limit = 1;
    const sender = ctxFor(w.users.sender);
    await composeAndSend(sender, input());
    await expect(composeAndSend(sender, { ...input(), subject: "second" })).rejects.toMatchObject({ code: "quota_exceeded", status: 429 });
  });

  it("suspension blocks new outbound but inbound still works", async () => {
    w.db.rows("workspaces").find((x) => x.id === w.ids.wsA)!.status = "suspended";
    const sender = ctxFor(w.users.sender);
    await expect(composeAndSend(sender, input())).rejects.toMatchObject({ code: "workspace_suspended", status: 403 });
    const received = await receiveFixture();
    expect(received).toHaveLength(1);
  });
});

describe("forward", () => {
  it("starts a new thread with no In-Reply-To, quotes the original and copies attachments", async () => {
    const [parent] = await receiveFixture();
    const sender = ctxFor(w.users.sender);
    const { sent, draftId } = await forwardMessage(sender, { messageId: parent.id as string, to: ["boss@x.example"], note: "FYI" });
    const msg = w.db.rows("messages").find((m) => m.id === draftId)!;
    expect(msg).toMatchObject({ subject: "Fwd: Question about my order", in_reply_to: null, references_header: null });
    expect(msg.thread_id).not.toBe(parent.thread_id);
    expect(msg.text_body).toContain("FYI");
    expect(msg.text_body).toContain("Forwarded message");
    expect(msg.text_body).toContain("Hi, where is my order?");
    expect(sent?.status).toBe("queued");

    const copied = w.db.rows("attachments").filter((a) => a.message_id === draftId);
    expect(copied).toHaveLength(1);
    expect(copied[0].storage_path).not.toBe(w.db.rows("attachments").find((a) => a.message_id === parent.id)!.storage_path);

    await processOutboxBatch(w.admin, adapter, { workerId: "t" });
    const [out] = adapter.getSentEmails();
    expect(out.input.headers?.["In-Reply-To"]).toBeUndefined();
    expect(out.input.attachments?.[0]).toMatchObject({ filename: "receipt.pdf" });
  });
});

describe("thread state + attachment URLs", () => {
  it("archive / mark unread are per-user and upsert state", async () => {
    const [m] = await receiveFixture();
    const sender = ctxFor(w.users.sender);
    const reader = ctxFor(w.users.reader);
    await archiveThread(sender, m.thread_id as string);
    await markThreadUnread(reader, m.thread_id as string);
    const states = w.db.rows("thread_user_state");
    expect(states.find((s) => s.user_id === w.users.sender)).toMatchObject({ is_archived: true });
    expect(states.find((s) => s.user_id === w.users.reader)).toMatchObject({ is_read: false, is_archived: false });
    await markThreadUnread(sender, m.thread_id as string);
    await setThreadState(sender, { threadId: m.thread_id as string, read: true });
    expect(states.filter((s) => s.user_id === w.users.sender)).toHaveLength(1);
    expect(states.find((s) => s.user_id === w.users.sender)).toMatchObject({ is_read: true, is_archived: true });
    await expect(setThreadState(sender, { threadId: m.thread_id as string })).rejects.toBeInstanceOf(InboxError);
  });

  it("read access mints a short-lived, download-forced signed URL; others get 404", async () => {
    await receiveFixture();
    const att = w.db.rows("attachments")[0];
    const { url, expiresInSeconds, filename } = await getAttachmentSignedUrl(ctxFor(w.users.reader), att.id as string);
    expect(expiresInSeconds).toBeLessThanOrEqual(60);
    expect(filename).toBe("receipt.pdf");
    expect(url).toContain("download=receipt.pdf");
    expect(url).toContain(String(att.storage_path));
    await expect(getAttachmentSignedUrl(ctxFor(w.users.outsider), att.id as string)).rejects.toMatchObject({ status: 404 });
    await expect(getAttachmentSignedUrl(ctxFor(w.users.reader), "not-a-uuid")).rejects.toMatchObject({ status: 404 });
  });

  it("an attachment on someone else's draft is not reachable", async () => {
    const author = ctxFor(w.users.sender);
    const { draftId } = await saveDraft(author, { mailboxId: w.ids.mbA1, to: ["x@x.example"], subject: "s", text: "t" });
    const att = w.db.seed("attachments", { message_id: draftId, workspace_id: w.ids.wsA, storage_path: `${w.ids.wsA}/${draftId}/f-secret.txt`, filename: "secret.txt", size_bytes: 1 });
    w.db.objects.set(`attachments/${att.storage_path}`, { data: new Uint8Array([1]) });
    await expect(getAttachmentSignedUrl(ctxFor(w.users.reader), att.id as string)).rejects.toMatchObject({ status: 404 });
    await expect(getAttachmentSignedUrl(author, att.id as string)).resolves.toMatchObject({ filename: "secret.txt" });
  });
});
