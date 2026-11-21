import { describe, expect, it } from "vitest";
import { buildSendInput, computeBackoffSeconds, decideFailure } from "./outbox";

describe("outbox retry policy", () => {
  it("backs off exponentially, capped at one hour", () => {
    const none = () => 0;
    expect(computeBackoffSeconds(1, none)).toBe(15);
    expect(computeBackoffSeconds(2, none)).toBe(30);
    expect(computeBackoffSeconds(3, none)).toBe(60);
    expect(computeBackoffSeconds(20, none)).toBe(3600);
    expect(computeBackoffSeconds(1, () => 1)).toBe(18);
  });

  it("decides retry / failed / dead", () => {
    expect(decideFailure({ retryable: false }, 1, 6)).toEqual({ action: "failed" });
    expect(decideFailure({ retryable: true }, 6, 6)).toEqual({ action: "dead" });
    expect(decideFailure({ retryable: true }, 2, 6, () => 0)).toEqual({ action: "retry", delaySeconds: 30 });
  });
});

describe("buildSendInput", () => {
  it("maps recipients, threading headers and bodies", () => {
    const input = buildSendInput(
      {
        from_address: "Support <support@a.example>",
        reply_to: null,
        subject: "Re: Hi",
        text_body: "t",
        html_body: "<p>t</p>",
        rfc_message_id: "<m@a.example>",
        in_reply_to: "<p@x.example>",
        references_header: "<p@x.example>",
      },
      [
        { address: "a@x.example", type: "to" },
        { address: "b@x.example", type: "cc" },
        { address: "c@x.example", type: "bcc" },
      ],
    );
    expect(input.to).toEqual(["a@x.example"]);
    expect(input.cc).toEqual(["b@x.example"]);
    expect(input.bcc).toEqual(["c@x.example"]);
    expect(input.headers).toEqual({
      "Message-ID": "<m@a.example>",
      "In-Reply-To": "<p@x.example>",
      References: "<p@x.example>",
    });
    expect(input.replyTo).toBeUndefined();
  });
});
