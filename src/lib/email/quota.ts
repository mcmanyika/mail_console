import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Monthly sending quota.
 *
 * Accounting model (all state transitions happen in SQL, atomically):
 *   enqueue_outbound_message  -> reserved += units          (may be refused)
 *   provider accepted email   -> finalize_job_quota(true)   reserved -> settled
 *   permanent failure / dead  -> finalize_job_quota(false)  reserved released
 * Retries never re-reserve. `reserved + settled` is compared with the
 * workspace's `monthly_sending_limit`.
 *
 * One "unit" = one unique recipient address (to + cc + bcc).
 */

export const MAX_RECIPIENTS_PER_MESSAGE = 50; // provider limit

/** `YYYY-MM` in UTC. Quotas reset on the first of the month, UTC. */
export function currentYearMonth(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function countQuotaUnits(recipients: { to?: string[]; cc?: string[]; bcc?: string[] }): number {
  const unique = new Set(
    [...(recipients.to ?? []), ...(recipients.cc ?? []), ...(recipients.bcc ?? [])].map((a) => a.trim().toLowerCase()),
  );
  unique.delete("");
  return unique.size;
}

export type QuotaStatus = {
  yearMonth: string;
  limit: number;
  reserved: number;
  settled: number;
  /** limit - reserved - settled (never negative). */
  remaining: number;
};

export function summarizeQuota(limit: number, reserved: number, settled: number, yearMonth: string): QuotaStatus {
  return { yearMonth, limit, reserved, settled, remaining: Math.max(limit - reserved - settled, 0) };
}

/** Read-only snapshot for dashboards (advisory; enforcement happens at enqueue). */
export async function getQuotaStatus(
  admin: AdminClient,
  workspaceId: string,
  date: Date = new Date(),
): Promise<QuotaStatus> {
  const yearMonth = currentYearMonth(date);
  const [{ data: ws, error: wsErr }, { data: usage, error: usageErr }] = await Promise.all([
    admin.from("workspaces").select("monthly_sending_limit").eq("id", workspaceId).single(),
    admin
      .from("monthly_usage")
      .select("reserved_count, settled_count")
      .eq("workspace_id", workspaceId)
      .eq("year_month", yearMonth)
      .maybeSingle(),
  ]);
  if (wsErr || !ws) throw new Error(`workspace not found: ${wsErr?.message ?? workspaceId}`);
  if (usageErr) throw new Error(`failed to read usage: ${usageErr.message}`);
  return summarizeQuota(ws.monthly_sending_limit, usage?.reserved_count ?? 0, usage?.settled_count ?? 0, yearMonth);
}

/** Finalize the reservation held by a job exactly once (idempotent). Returns true if it changed state. */
export async function finalizeJobQuota(admin: AdminClient, jobId: string, consumed: boolean): Promise<boolean> {
  const { data, error } = await admin.rpc("finalize_job_quota", { p_job_id: jobId, p_consumed: consumed });
  if (error) throw new Error(`finalize_job_quota failed: ${error.message}`);
  return data === true;
}
