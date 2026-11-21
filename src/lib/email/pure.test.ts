import { describe, expect, it, vi } from "vitest";

vi.mock("./sanitize", async (importOriginal) => {
  try {
    return await importOriginal<typeof import("./sanitize")>();
  } catch {
    return await import("../testing/sanitize-fallback");
  }
});
import { domainOf, extractAddress, extractAddresses, formatFromHeader, isValidEmailAddress, splitAddressList, stripPlusTag } from "./address";
import { DELIVERY_RANK, aggregateDeliveryStatus, shouldAdvanceDeliveryState, statesBelow } from "./delivery";
import { deterministicUuid, safeFilename, safeMimeType, trustedRecipients } from "./inbound";
import { hashRequest, stableStringify } from "./idempotency";
import { TemplateError, renderTemplate, templateVariableNames } from "./templates";

describe("addresses", () => {
  it("validates and extracts", () => {
    expect(isValidEmailAddress("a.b+c@sub.example.com")).toBe(true);
    for (const bad of ["a@b", "a b@c.com", "@x.com", "a@x.com,b@y.com", "a@x..com", "a\r\n@x.com"]) expect(isValidEmailAddress(bad)).toBe(false);
    expect(extractAddress('"Doe, Jane" <Jane@Example.com>')).toBe("jane@example.com");
    expect(extractAddress("nope")).toBeNull();
    expect(splitAddressList('"Doe, Jane" <j@x.com>, b@y.com')).toEqual(['"Doe, Jane" <j@x.com>', "b@y.com"]);
    expect(extractAddresses(["A@x.com, b@y.com", "a@x.com", null])).toEqual(["a@x.com", "b@y.com"]);
    expect(stripPlusTag("support+vip@x.com")).toBe("support@x.com");
    expect(domainOf("a@Mail.X.com")).toBe("mail.x.com");
  });

  it("builds a From header that cannot break out of the header", () => {
    expect(formatFromHeader("Support", "s@x.com")).toBe('"Support" <s@x.com>');
    const evil = formatFromHeader('Evil"\r\nBcc: v@x.com <x>', "s@x.com");
    expect(evil).not.toMatch(/[\r\n]/);
    expect(evil.match(/</g)).toHaveLength(1);
    expect(formatFromHeader(null, "s@x.com")).toBe("s@x.com");
  });
});

describe("delivery state machine", () => {
  it("only moves forward", () => {
    expect(shouldAdvanceDeliveryState("sent", "delivered")).toBe(true);
    expect(shouldAdvanceDeliveryState("delivered", "sent")).toBe(false);
    expect(shouldAdvanceDeliveryState("delivered", "delivered")).toBe(false);
    expect(shouldAdvanceDeliveryState("bounced", "delivered")).toBe(false);
    expect(shouldAdvanceDeliveryState("delivered", "bounced")).toBe(true); // async bounce after acceptance
    expect(shouldAdvanceDeliveryState("bounced", "complained")).toBe(true);
    expect(statesBelow("delivered").sort()).toEqual(["delayed", "pending", "received", "sent"]);
    expect(Object.keys(DELIVERY_RANK)).toHaveLength(9);
  });
  it("rolls recipient states up", () => {
    expect(aggregateDeliveryStatus("queued", [])).toBe("queued");
    expect(aggregateDeliveryStatus("failed", ["pending"])).toBe("failed");
    expect(aggregateDeliveryStatus("submitted", ["sent", "sent"])).toBe("sent");
    expect(aggregateDeliveryStatus("submitted", ["delivered", "delivered"])).toBe("delivered");
    expect(aggregateDeliveryStatus("submitted", ["delivered", "bounced"])).toBe("bounced");
    expect(aggregateDeliveryStatus("submitted", ["delivered", "delayed"])).toBe("delayed");
  });
});

describe("inbound helpers", () => {
  it("trusts received_for exclusively, then to/cc/bcc — nothing else", () => {
    expect(trustedRecipients({ to: ["A@x.com"], cc: "b@x.com", bcc: ["c@x.com"], headers: { "delivered-to": "evil@x.com" } } as never)).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
    expect(trustedRecipients({ received_for: ["real@x.com"], to: ["other@x.com"] })).toEqual(["real@x.com"]);
  });
  it("sanitises filenames and mime types", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("..\\..\\boot.ini")).toBe("boot.ini");
    expect(safeFilename(".htaccess")).toBe("_htaccess");
    expect(safeFilename("a\u0000b\r\nc.txt")).toBe("a_b__c.txt");
    expect(safeFilename("")).toBe("attachment");
    expect(safeFilename("x".repeat(500)).length).toBe(120);
    expect(safeMimeType("Application/PDF; charset=x")).toBe("application/pdf");
    expect(safeMimeType("javascript")).toBe("application/octet-stream");
    expect(safeMimeType("text/html\r\nX: y")).toBe("application/octet-stream");
  });
  it("derives stable uuid-shaped object ids", () => {
    expect(deterministicUuid("a")).toBe(deterministicUuid("a"));
    expect(deterministicUuid("a")).not.toBe(deterministicUuid("b"));
    expect(deterministicUuid("a")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("idempotency hashing", () => {
  it("is key-order independent and ignores undefined", () => {
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe('{"a":[2,{"d":1}],"b":1}');
    expect(hashRequest({ a: 1, b: 2 })).toBe(hashRequest({ b: 2, a: 1 }));
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
  });
});

describe("templates", () => {
  const tpl = { subject: "Hi {{name}}", body_text: "Code {{ code }}", body_html: "<i>{{name}}</i>" };
  it("renders, escapes HTML only in html, and lists variables", () => {
    const out = renderTemplate(tpl, { name: "<Tom & Jerry>", code: 7 });
    expect(out).toEqual({ subject: "Hi <Tom & Jerry>", text: "Code 7", html: "<i>&lt;Tom &amp; Jerry&gt;</i>" });
    expect(templateVariableNames("{{a}} {{b}} {{a}}")).toEqual(["a", "b"]);
  });
  it("errors on missing variables and subject line breaks", () => {
    expect(() => renderTemplate(tpl, { name: "x" })).toThrow(TemplateError);
    expect(() => renderTemplate(tpl, { name: "x\nBcc: y", code: 1 })).toThrow(/line breaks/);
    expect(() => renderTemplate(tpl, Object.create({ name: "inherited", code: 1 }))).toThrow(TemplateError); // no prototype lookups
  });
});
