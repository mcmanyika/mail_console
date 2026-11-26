import { writeAudit } from "@/lib/audit";
import { planCampaignContactLimit } from "@/lib/billing/plans";
import { isValidEmailAddress, normalizeAddress } from "@/lib/email/address";
import { discardDraftRow, insertDraftMessage, resolveSender } from "@/lib/email/compose";
import { enqueueOutboundMessage } from "@/lib/email/outbox";
import { getQuotaStatus } from "@/lib/email/quota";
import { makeSnippet, textToHtml } from "@/lib/email/sanitize";
import { renderTemplateString, TemplateError, type TemplateVars } from "@/lib/email/templates";
import type { AdminClient } from "@/lib/supabase/admin";
import type { CampaignRecipientRow, CampaignRow, Json, WorkspacePlan } from "@/lib/types/database";

export const CAMPAIGN_LIMITS = {
  /** Absolute ceiling across all plans (Scale). Per-plan caps are lower. */
  maxContactsPerList: 5_000,
  maxCsvBytes: 2_000_000,
  fanOutBatchSize: 25,
  maxCampaignsPerTick: 5,
} as const;

export function contactLimitForWorkspacePlan(plan: WorkspacePlan | string | null | undefined): number {
  return Math.min(CAMPAIGN_LIMITS.maxContactsPerList, planCampaignContactLimit(plan));
}

export class CampaignError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not_found"
      | "forbidden"
      | "invalid"
      | "quota"
      | "inactive"
      | "empty"
      | "too_large",
  ) {
    super(message);
    this.name = "CampaignError";
  }
}

export type ParsedContact = { email: string; fullName: string | null; fields: Record<string, string> };

/** Parse a simple CSV with header row. Requires an `email` column. */
export function parseContactsCsv(raw: string): { contacts: ParsedContact[]; errors: string[] } {
  const text = raw.replace(/^\uFEFF/, "").trim();
  if (!text) return { contacts: [], errors: ["CSV is empty"] };
  if (Buffer.byteLength(text, "utf8") > CAMPAIGN_LIMITS.maxCsvBytes) {
    return { contacts: [], errors: ["CSV is too large (max 2 MB)"] };
  }

  const rows = parseCsvRows(text);
  if (rows.length < 2) return { contacts: [], errors: ["CSV needs a header row and at least one contact"] };

  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const emailIdx = header.findIndex((h) => h === "email" || h === "e-mail" || h === "email_address");
  if (emailIdx < 0) return { contacts: [], errors: ["CSV must include an email column"] };
  const nameIdx = header.findIndex((h) => h === "name" || h === "full_name" || h === "fullname");

  const contacts: ParsedContact[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.every((c) => !c.trim())) continue;
    const emailRaw = (row[emailIdx] ?? "").trim();
    const email = normalizeAddress(emailRaw);
    if (!email || !isValidEmailAddress(email)) {
      errors.push(`Row ${i + 1}: invalid email`);
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);

    const fullName = nameIdx >= 0 ? (row[nameIdx]?.trim() || null) : null;
    const fields: Record<string, string> = {};
    header.forEach((h, idx) => {
      if (idx === emailIdx || idx === nameIdx || !h) return;
      if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(h)) return;
      const v = (row[idx] ?? "").trim();
      if (v) fields[h] = v.slice(0, 500);
    });
    if (fullName) fields.first_name = fullName.split(/\s+/)[0] ?? fullName;
    contacts.push({ email, fullName: fullName?.slice(0, 200) ?? null, fields });
  }

  if (contacts.length > CAMPAIGN_LIMITS.maxContactsPerList) {
    return { contacts: [], errors: [`At most ${CAMPAIGN_LIMITS.maxContactsPerList} contacts per list`] };
  }
  return { contacts, errors: errors.slice(0, 20) };
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cur);
      cur = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
      continue;
    }
    cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c.length) || rows.length === 0) rows.push(row);
  return rows;
}

function varsForRecipient(r: Pick<CampaignRecipientRow, "email" | "full_name" | "fields">): TemplateVars {
  const fields = (r.fields && typeof r.fields === "object" && !Array.isArray(r.fields) ? r.fields : {}) as Record<
    string,
    unknown
  >;
  const out: TemplateVars = { email: r.email };
  if (r.full_name) {
    out.name = r.full_name;
    out.full_name = r.full_name;
    out.first_name = r.full_name.split(/\s+/)[0] ?? r.full_name;
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    out[k] = typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : String(v);
  }
  return out;
}

function softVars(source: string, vars: TemplateVars): TemplateVars {
  const out: TemplateVars = { ...vars };
  for (const m of source.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]{0,63})\s*\}\}/g)) {
    const name = m[1]!;
    if (!Object.prototype.hasOwnProperty.call(out, name)) out[name] = "";
  }
  return out;
}

function renderCampaignContent(
  campaign: Pick<CampaignRow, "subject" | "body_text">,
  vars: TemplateVars,
): { subject: string; text: string; html: string } {
  // Missing vars become empty string for campaigns (friendlier than hard-fail mid-send).
  try {
    const subject = renderTemplateString(campaign.subject, softVars(campaign.subject, vars), "subject");
    const text = renderTemplateString(campaign.body_text, softVars(campaign.body_text, vars), "text");
    return { subject, text, html: textToHtml(text) };
  } catch (e) {
    if (e instanceof TemplateError) throw new CampaignError(e.message, "invalid");
    throw e;
  }
}

/** Copy list contacts into campaign_recipients and mark campaign sending. */
export async function startCampaign(
  admin: AdminClient,
  opts: {
    campaignId: string;
    workspaceId: string;
    actorUserId: string | null;
    when?: "now" | "scheduled";
  },
): Promise<CampaignRow> {
  const { data: campaign, error } = await admin
    .from("campaigns")
    .select("*")
    .eq("id", opts.campaignId)
    .eq("workspace_id", opts.workspaceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!campaign) throw new CampaignError("Campaign not found", "not_found");
  if (campaign.status !== "draft" && campaign.status !== "scheduled") {
    throw new CampaignError("Only draft or scheduled campaigns can be started", "invalid");
  }

  const { count, error: cErr } = await admin
    .from("audience_contacts")
    .select("id", { count: "exact", head: true })
    .eq("list_id", campaign.list_id)
    .eq("workspace_id", opts.workspaceId);
  if (cErr) throw new Error(cErr.message);
  if (!count) throw new CampaignError("This list has no contacts", "empty");

  const { data: workspace, error: wErr } = await admin
    .from("workspaces")
    .select("plan, monthly_sending_limit, status")
    .eq("id", opts.workspaceId)
    .maybeSingle();
  if (wErr) throw new Error(wErr.message);
  if (!workspace) throw new CampaignError("Workspace not found", "not_found");
  if (workspace.status !== "active") {
    throw new CampaignError("This workspace cannot send while suspended", "inactive");
  }

  const planCap = contactLimitForWorkspacePlan(workspace.plan);
  if (count > planCap) {
    throw new CampaignError(
      `Your ${workspace.plan === "custom" ? "plan" : workspace.plan} package allows at most ${planCap.toLocaleString()} contacts per campaign (this list has ${count.toLocaleString()}). Remove contacts or upgrade.`,
      "too_large",
    );
  }

  const quota = await getQuotaStatus(admin, opts.workspaceId);
  if (count > quota.remaining) {
    throw new CampaignError(
      `This campaign needs ${count.toLocaleString()} sends but only ${quota.remaining.toLocaleString()} of your ${quota.limit.toLocaleString()}/mo package allowance remain. Wait for the monthly reset, raise the limit, or shorten the list.`,
      "quota",
    );
  }

  // Clear previous recipients if re-starting a scheduled draft copy (shouldn't happen).
  await admin.from("campaign_recipients").delete().eq("campaign_id", campaign.id);

  const pageSize = 500;
  let from = 0;
  let total = 0;
  for (;;) {
    const { data: page, error: pErr } = await admin
      .from("audience_contacts")
      .select("email, full_name, fields")
      .eq("list_id", campaign.list_id)
      .eq("workspace_id", opts.workspaceId)
      .order("email")
      .range(from, from + pageSize - 1);
    if (pErr) throw new Error(pErr.message);
    if (!page?.length) break;
    const rows = page.map((c) => ({
      workspace_id: opts.workspaceId,
      campaign_id: campaign.id,
      email: c.email,
      full_name: c.full_name,
      fields: (c.fields ?? {}) as Json,
      status: "pending" as const,
    }));
    const { error: iErr } = await admin.from("campaign_recipients").insert(rows);
    if (iErr) throw new Error(iErr.message);
    total += rows.length;
    from += pageSize;
    if (page.length < pageSize) break;
  }

  const now = new Date().toISOString();
  const { data: updated, error: uErr } = await admin
    .from("campaigns")
    .update({
      status: "sending",
      started_at: now,
      completed_at: null,
      total_count: total,
      sent_count: 0,
      failed_count: 0,
      skipped_count: 0,
      scheduled_at: null,
    })
    .eq("id", campaign.id)
    .select("*")
    .single();
  if (uErr || !updated) throw new Error(uErr?.message ?? "failed to start campaign");

  await writeAudit(admin, {
    workspaceId: opts.workspaceId,
    actorUserId: opts.actorUserId,
    action: "campaign.started",
    resourceType: "campaign",
    resourceId: campaign.id,
    metadata: { total, when: opts.when ?? "now" },
  });
  return updated;
}

async function processOneRecipient(
  admin: AdminClient,
  campaign: CampaignRow,
  recipient: CampaignRecipientRow,
): Promise<"sent" | "failed" | "skipped" | "quota"> {
  let content: { subject: string; text: string; html: string };
  try {
    content = renderCampaignContent(campaign, varsForRecipient(recipient));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "render failed";
    await admin.rpc("bump_campaign_recipient_result", {
      p_recipient_id: recipient.id,
      p_status: "failed",
      p_error: msg.slice(0, 500),
    });
    return "failed";
  }

  let sender;
  try {
    sender = await resolveSender(admin, { id: campaign.mailbox_id }, { workspaceId: campaign.workspace_id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "sender unavailable";
    await admin.rpc("bump_campaign_recipient_result", {
      p_recipient_id: recipient.id,
      p_status: "failed",
      p_error: msg.slice(0, 500),
    });
    return "failed";
  }

  const messageId = await insertDraftMessage(admin, {
    sender,
    authorUserId: campaign.created_by ?? undefined,
    recipients: { to: [recipient.email], cc: [], bcc: [] },
    subject: content.subject,
    text: content.text,
    html: content.html,
    snippet: makeSnippet({ text: content.text }),
  });

  const enq = await enqueueOutboundMessage(admin, {
    messageId,
    idempotencyKey: `campaign:${campaign.id}:${recipient.id}`,
    recipients: { to: [recipient.email] },
  });

  if (enq.status === "queued" || enq.status === "already_queued") {
    await admin.rpc("bump_campaign_recipient_result", {
      p_recipient_id: recipient.id,
      p_status: "sent",
      p_message_id: messageId,
    });
    return "sent";
  }

  await discardDraftRow(admin, messageId);

  if (enq.status === "quota_exceeded") {
    // Put back to pending so a later tick can retry when quota frees / month rolls.
    await admin
      .from("campaign_recipients")
      .update({ status: "pending", claimed_at: null, claimed_by: null, error: "quota_exceeded" })
      .eq("id", recipient.id)
      .eq("status", "queued");
    await admin.from("campaigns").update({ status: "paused" }).eq("id", campaign.id).eq("status", "sending");
    return "quota";
  }

  if (enq.status === "workspace_inactive") {
    await admin.rpc("bump_campaign_recipient_result", {
      p_recipient_id: recipient.id,
      p_status: "skipped",
      p_error: "workspace_inactive",
    });
    return "skipped";
  }

  await admin.rpc("bump_campaign_recipient_result", {
    p_recipient_id: recipient.id,
    p_status: "failed",
    p_error: enq.status === "invalid" ? enq.reason : "enqueue_failed",
  });
  return "failed";
}

export type CampaignWorkerStats = {
  campaigns: number;
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
  pausedQuota: number;
};

/** Fan out pending recipients for sending/scheduled-due campaigns. */
export async function processCampaignFanOut(
  admin: AdminClient,
  opts: { workerId: string; batchSize?: number; maxCampaigns?: number } = { workerId: "cron" },
): Promise<CampaignWorkerStats> {
  const batchSize = opts.batchSize ?? CAMPAIGN_LIMITS.fanOutBatchSize;
  const maxCampaigns = opts.maxCampaigns ?? CAMPAIGN_LIMITS.maxCampaignsPerTick;
  const stats: CampaignWorkerStats = { campaigns: 0, claimed: 0, sent: 0, failed: 0, skipped: 0, pausedQuota: 0 };

  // Promote due scheduled campaigns.
  const now = new Date().toISOString();
  const { data: due } = await admin
    .from("campaigns")
    .select("id, workspace_id, created_by")
    .eq("status", "scheduled")
    .lte("scheduled_at", now)
    .limit(maxCampaigns);
  for (const c of due ?? []) {
    try {
      await startCampaign(admin, {
        campaignId: c.id,
        workspaceId: c.workspace_id,
        actorUserId: c.created_by,
        when: "scheduled",
      });
    } catch (err) {
      console.error("[campaigns] failed to start scheduled", c.id, err instanceof Error ? err.message : err);
    }
  }

  const { data: active } = await admin
    .from("campaigns")
    .select("*")
    .eq("status", "sending")
    .order("started_at", { ascending: true })
    .limit(maxCampaigns);

  for (const campaign of active ?? []) {
    stats.campaigns += 1;
    const { data: claimed, error } = await admin.rpc("claim_campaign_recipients", {
      p_campaign_id: campaign.id,
      p_worker_id: opts.workerId,
      p_batch_size: batchSize,
    });
    if (error) {
      console.error("[campaigns] claim failed", campaign.id, error.message);
      continue;
    }
    const rows = (claimed ?? []) as CampaignRecipientRow[];
    stats.claimed += rows.length;
    for (const r of rows) {
      const result = await processOneRecipient(admin, campaign, r);
      if (result === "sent") stats.sent += 1;
      else if (result === "failed") stats.failed += 1;
      else if (result === "skipped") stats.skipped += 1;
      else if (result === "quota") {
        stats.pausedQuota += 1;
        break;
      }
    }
  }

  return stats;
}
