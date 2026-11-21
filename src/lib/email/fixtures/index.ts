/**
 * Synthetic webhook fixtures. Everything here is fake: reserved `.example`
 * domains, `recv_fixture_*` provider ids. Used by unit tests and safe to POST
 * to a DEMO_MODE server (see docs/api.md).
 */
import { Webhook } from "svix";
import type { ReceivedEmail } from "@/lib/resend/types";
import delayedJson from "./email.delivery_delayed.json";
import bouncedJson from "./email.bounced.json";
import deliveredJson from "./email.delivered.json";
import receivedJson from "./email.received.json";
import receivedMultiJson from "./email.received.multi.json";
import receivedSpoofedJson from "./email.received.spoofed-headers.json";
import receivedUnmatchedJson from "./email.received.unmatched.json";
import contentJson from "./received-content.json";

export type FixtureEvent = { id?: string; type: string; created_at: string; data: Record<string, unknown> };

export const fixtures = {
  received: receivedJson as FixtureEvent,
  receivedMulti: receivedMultiJson as FixtureEvent,
  receivedUnmatched: receivedUnmatchedJson as FixtureEvent,
  receivedSpoofedHeaders: receivedSpoofedJson as FixtureEvent,
  delivered: deliveredJson as FixtureEvent,
  bounced: bouncedJson as FixtureEvent,
  delayed: delayedJson as FixtureEvent,
};

/** Provider-side content for the `recv_fixture_*` emails (what `getReceivedEmail` returns). */
export function receivedContent(emailId: string): ReceivedEmail {
  const c = (contentJson as Record<string, Omit<ReceivedEmail, "providerEmailId">>)[emailId];
  if (!c) throw new Error(`no content fixture for ${emailId}`);
  return { providerEmailId: emailId, ...(structuredClone(c) as Omit<ReceivedEmail, "providerEmailId">) };
}

export const FIXTURE_ATTACHMENT_BYTES = new TextEncoder().encode("hello world");

/** Fills in the provider email id of a delivery fixture. */
export function deliveryFixture(base: FixtureEvent, providerEmailId: string, overrides: Partial<Pick<FixtureEvent, "created_at">> & { to?: string[] } = {}): FixtureEvent {
  const e = structuredClone(base);
  e.data.email_id = providerEmailId;
  if (overrides.to) e.data.to = overrides.to;
  if (overrides.created_at) e.created_at = overrides.created_at;
  return e;
}

export const TEST_WEBHOOK_SECRET = "whsec_" + Buffer.from("mail-console-test-secret-0123456789").toString("base64");

/** Builds a Request-like (rawBody + headers) pair signed exactly like Resend/Svix. */
export function signedWebhook(event: FixtureEvent, opts: { eventId: string; secret?: string; timestamp?: Date }): { rawBody: string; headers: Headers } {
  const rawBody = JSON.stringify(event);
  const timestamp = opts.timestamp ?? new Date();
  const signature = new Webhook(opts.secret ?? TEST_WEBHOOK_SECRET).sign(opts.eventId, timestamp, rawBody);
  return {
    rawBody,
    headers: new Headers({
      "content-type": "application/json",
      "svix-id": opts.eventId,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": signature,
    }),
  };
}

/** Unsigned demo delivery (requires DEMO_MODE=true on the server). */
export function demoWebhook(event: FixtureEvent, eventId: string): { rawBody: string; headers: Headers } {
  return {
    rawBody: JSON.stringify(event),
    headers: new Headers({ "content-type": "application/json", "svix-id": eventId, "x-mail-console-demo": "1" }),
  };
}
