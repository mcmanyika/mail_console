import { describe, expect, it } from "vitest";
import { seedWorld } from "@/lib/testing/world";
import { MockEmailAdapter } from "@/lib/resend/mock";
import { enqueueOutboundMessage, processOutboxBatch } from "./outbox";
import { currentYearMonth, getQuotaStatus } from "./quota";

/**
 * Quota accounting under concurrency (unit level).
 *
 * The enqueue/reserve/finalize functions are SQL (`for update` row locks on
 * the monthly_usage row). Here they run as the TypeScript ports in
 * src/lib/testing/fake-admin.ts, which execute atomically per call, so these
 * tests verify the TS orchestration + the accounting invariants:
 *     reserved + settled <= limit      (never oversold)
 *     reserved + settled == accepted   (no leaks / double counts)
 * An integration run against local Supabase (`supabase start`) exercises the
 * real row locking.
 */

function draft(w: ReturnType<typeof seedWorld>, i: number) {
  return w.db.seed("messages", {
    workspace_id: w.ids.wsA,
    mailbox_id: w.ids.mbA1,
    direction: "draft",
    lifecycle_state: "draft",
    from_address: "support@a.example",
    subject: `m${i}`,
    author_user_id: w.users.sender,
  }).id as string;
}

describe("quota concurrency", () => {
  it("N parallel enqueues against a limit of L accept exactly L units", async () => {
    const w = seedWorld();
    w.db.rows("workspaces").find((x) => x.id === w.ids.wsA)!.monthly_sending_limit = 7;

    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        enqueueOutboundMessage(w.admin, { messageId: draft(w, i), idempotencyKey: `k-${i}`, recipients: { to: [`u${i}@x.example`] } }),
      ),
    );
    expect(results.filter((r) => r.status === "queued")).toHaveLength(7);
    expect(results.filter((r) => r.status === "quota_exceeded")).toHaveLength(33);

    const q = await getQuotaStatus(w.admin, w.ids.wsA);
    expect(q).toMatchObject({ reserved: 7, settled: 0, remaining: 0, limit: 7 });
  });

  it("multi-recipient messages consume one unit per unique address and cannot straddle the limit", async () => {
    const w = seedWorld();
    w.db.rows("workspaces").find((x) => x.id === w.ids.wsA)!.monthly_sending_limit = 5;
    const three = (i: number) => ({ to: [`a${i}@x.example`, `b${i}@x.example`], cc: [`a${i}@x.example`, `c${i}@x.example`] }); // 3 unique
    const results = await Promise.all([0, 1, 2].map((i) => enqueueOutboundMessage(w.admin, { messageId: draft(w, i), idempotencyKey: `m-${i}`, recipients: three(i) })));
    expect(results.filter((r) => r.status === "queued")).toHaveLength(1); // 3 + 3 > 5
    expect((await getQuotaStatus(w.admin, w.ids.wsA)).reserved).toBe(3);
  });

  it("enqueueing the same idempotency key concurrently reserves once", async () => {
    const w = seedWorld();
    const id = draft(w, 0);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => enqueueOutboundMessage(w.admin, { messageId: id, idempotencyKey: "same", recipients: { to: ["a@x.example"] } })),
    );
    expect(results.filter((r) => r.status === "queued")).toHaveLength(1);
    expect(results.filter((r) => r.status === "already_queued")).toHaveLength(9);
    expect((await getQuotaStatus(w.admin, w.ids.wsA)).reserved).toBe(1);
  });

  it("reserved -> settled on success, released on permanent failure; retries never re-reserve", async () => {
    const w = seedWorld();
    const ok = draft(w, 1);
    const bad = draft(w, 2);
    w.db.rows("messages").find((m) => m.id === bad)!.subject = "[mock-fail] boom";
    const flaky = draft(w, 3);
    w.db.rows("messages").find((m) => m.id === flaky)!.subject = "[mock-transient] once";
    for (const [id, key] of [[ok, "o"], [bad, "b"], [flaky, "f"]] as const) {
      await enqueueOutboundMessage(w.admin, { messageId: id, idempotencyKey: key, recipients: { to: [`${key}@x.example`] } });
      w.db.seed("message_recipients", { message_id: id, workspace_id: w.ids.wsA, address: `${key}@x.example`, type: "to" });
    }
    expect((await getQuotaStatus(w.admin, w.ids.wsA)).reserved).toBe(3);

    const adapter = MockEmailAdapter.createIsolated();
    await processOutboxBatch(w.admin, adapter, { workerId: "w" });
    let q = await getQuotaStatus(w.admin, w.ids.wsA);
    expect(q).toMatchObject({ reserved: 1, settled: 1 }); // ok settled, bad released, flaky still reserved (retry pending)

    // make the flaky job due now and run again: succeeds, settles — no extra reservation
    w.db.rows("outbox_jobs").find((j) => j.status === "pending")!.next_attempt_at = new Date(Date.now() - 1000).toISOString();
    await processOutboxBatch(w.admin, adapter, { workerId: "w" });
    q = await getQuotaStatus(w.admin, w.ids.wsA);
    expect(q).toMatchObject({ reserved: 0, settled: 2 });
    expect(adapter.getSentEmails()).toHaveLength(2);
    expect(w.db.rows("monthly_usage")[0].year_month).toBe(currentYearMonth());
  });

  it("concurrent finalisation is exactly-once", async () => {
    const w = seedWorld();
    const id = draft(w, 1);
    await enqueueOutboundMessage(w.admin, { messageId: id, idempotencyKey: "x", recipients: { to: ["a@x.example"] } });
    const job = w.db.rows("outbox_jobs")[0].id as string;
    const { finalizeJobQuota } = await import("./quota");
    const results = await Promise.all(Array.from({ length: 8 }, () => finalizeJobQuota(w.admin, job, true)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await getQuotaStatus(w.admin, w.ids.wsA)).toMatchObject({ reserved: 0, settled: 1 });
  });
});
