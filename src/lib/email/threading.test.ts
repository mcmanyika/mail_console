import { describe, expect, it } from "vitest";
import {
  buildReplyHeaders,
  generateRfcMessageId,
  looksLikeReply,
  normalizeMessageId,
  normalizeSubject,
  parseMessageIds,
  resolveThread,
  type ThreadLookup,
} from "./threading";

describe("subject + message-id helpers", () => {
  it("normalizes reply/forward prefixes", () => {
    expect(normalizeSubject("Re: RE: Fwd:  Hello   World ")).toBe("hello world");
    expect(normalizeSubject("AW: Frage")).toBe("frage");
    expect(normalizeSubject(null)).toBe("");
    expect(looksLikeReply("Re: x")).toBe(true);
    expect(looksLikeReply("Regarding x")).toBe(false);
  });

  it("normalizes and parses message ids", () => {
    expect(normalizeMessageId(" abc@x.example ")).toBe("<abc@x.example>");
    expect(normalizeMessageId("<abc@x.example>")).toBe("<abc@x.example>");
    expect(normalizeMessageId("has space")).toBeNull();
    expect(parseMessageIds("<a@x> <b@x>\n <a@x>")).toEqual(["<a@x>", "<b@x>"]);
    expect(generateRfcMessageId("Example.COM")).toMatch(/^<[\w-]{24}@example\.com>$/);
  });

  it("builds reply headers, extending References and capping length", () => {
    expect(buildReplyHeaders({ rfcMessageId: "<p@x>", referencesHeader: "<a@x> <b@x>" })).toEqual({
      inReplyTo: "<p@x>",
      references: "<a@x> <b@x> <p@x>",
    });
    expect(buildReplyHeaders({ rfcMessageId: null, referencesHeader: null })).toEqual({ inReplyTo: null, references: null });
    const long = Array.from({ length: 40 }, (_, i) => `<m${i}@x>`).join(" ");
    const { references } = buildReplyHeaders({ rfcMessageId: "<p@x>", referencesHeader: long });
    expect(references!.split(" ")).toHaveLength(20);
    expect(references!.endsWith("<p@x>")).toBe(true);
  });
});

function lookup(overrides: Partial<ThreadLookup> = {}): ThreadLookup & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    findThreadByMessageIds: async (...a) => {
      calls.push("headers");
      return overrides.findThreadByMessageIds ? overrides.findThreadByMessageIds(...a) : null;
    },
    findThreadBySubject: async (...a) => {
      calls.push("subject");
      return overrides.findThreadBySubject ? overrides.findThreadBySubject(...a) : null;
    },
  };
}

describe("resolveThread", () => {
  it("prefers header matches", async () => {
    const l = lookup({ findThreadByMessageIds: async () => "t-header", findThreadBySubject: async () => "t-subject" });
    const r = await resolveThread(l, { mailboxId: "m", subject: "Re: Hi", inReplyTo: "<a@x>" });
    expect(r).toEqual({ threadId: "t-header", reason: "headers" });
    expect(l.calls).toEqual(["headers"]);
  });

  it("falls back to subject only for reply-looking subjects", async () => {
    const l = lookup({ findThreadBySubject: async () => "t-subject" });
    expect(await resolveThread(l, { mailboxId: "m", subject: "Re: Hi" })).toEqual({ threadId: "t-subject", reason: "subject" });
    expect(await resolveThread(l, { mailboxId: "m", subject: "Hi" })).toEqual({ threadId: null, reason: "new" });
  });

  it("starts a new thread when nothing matches and passes a 30-day window", async () => {
    let since: Date | undefined;
    const l = lookup({ findThreadBySubject: async (_m, _s, d) => ((since = d), null) });
    const now = new Date("2026-11-20T00:00:00Z");
    const r = await resolveThread(l, { mailboxId: "m", subject: "Re: x", references: "<z@x>", now });
    expect(r).toEqual({ threadId: null, reason: "new" });
    expect(since?.toISOString()).toBe("2026-10-21T00:00:00.000Z");
  });
});
