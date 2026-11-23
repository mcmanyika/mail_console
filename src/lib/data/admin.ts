import { connection } from "next/server";
import { cache } from "react";
import { AuthzError } from "@/lib/auth/authz";
import { getIsPlatformAdmin } from "@/lib/auth/session";
import { currentYearMonth, summarizeQuota, type QuotaStatus } from "@/lib/email/quota";
import { lastYearMonths, startOfMonthIso } from "@/lib/format";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  AuditLogRow,
  DeliveryState,
  DomainRow,
  DomainStatus,
  InboundDomainStatus,
  OutboxStatus,
  InvitationRole,
  WorkspaceRole,
  WorkspaceRow,
} from "@/lib/types/database";

/** Every loader re-checks platform-admin status: the service-role client bypasses RLS. */
async function adminOnly() {
  // Stats use currentYearMonth()/new Date(); opt out of prerender first.
  await connection();
  if (!(await getIsPlatformAdmin())) throw new AuthzError("Platform admin access required");
  return createAdminClient();
}

const FAILING: ReadonlyArray<DomainStatus | InboundDomainStatus> = ["failed", "partially_failed", "temporary_failure"];
export const isFailingStatus = (s: string) => (FAILING as readonly string[]).includes(s);

export type Verification = "none" | "verified" | "pending" | "failing";

/** Outbound + inbound readiness rolled up across a workspace's domains. */
export function summarizeVerification(domains: Pick<DomainRow, "send_status" | "inbound_status">[]): Verification {
  if (domains.length === 0) return "none";
  if (domains.some((d) => isFailingStatus(d.send_status) || isFailingStatus(d.inbound_status))) return "failing";
  const allOk = domains.every((d) => d.send_status === "verified" && (d.inbound_status === "verified" || d.inbound_status === "disabled"));
  return allOk ? "verified" : "pending";
}

// ---- overview ------------------------------------------------------------------------
export type Overview = {
  activeWorkspaces: number;
  totalWorkspaces: number;
  suspendedWorkspaces: number;
  verifiedDomains: number;
  totalDomains: number;
  emailsSubmitted: number;
  emailsReserved: number;
  delivery: { delivered: number; negative: number; rate: number | null };
  month: string;
};

export const getOverview = cache(async (): Promise<Overview> => {
  const admin = await adminOnly();
  const month = currentYearMonth();
  const since = startOfMonthIso();
  const count = (q: PromiseLike<{ count: number | null }>) => q.then((r) => r.count ?? 0);
  const recip = (states: DeliveryState[]) =>
    count(admin.from("message_recipients").select("id", { count: "exact", head: true }).in("delivery_state", states).gte("updated_at", since));

  const [active, total, suspended, verified, domainsTotal, usage, delivered, negative] = await Promise.all([
    count(admin.from("workspaces").select("id", { count: "exact", head: true }).eq("status", "active")),
    count(admin.from("workspaces").select("id", { count: "exact", head: true })),
    count(admin.from("workspaces").select("id", { count: "exact", head: true }).eq("status", "suspended")),
    count(admin.from("domains").select("id", { count: "exact", head: true }).eq("send_status", "verified")),
    count(admin.from("domains").select("id", { count: "exact", head: true })),
    admin.from("monthly_usage").select("settled_count, reserved_count").eq("year_month", month),
    recip(["delivered"]),
    recip(["bounced", "complained", "failed", "suppressed"]),
  ]);
  const settled = (usage.data ?? []).reduce((n, r) => n + r.settled_count, 0);
  const reserved = (usage.data ?? []).reduce((n, r) => n + r.reserved_count, 0);
  const denom = delivered + negative;
  return {
    activeWorkspaces: active,
    totalWorkspaces: total,
    suspendedWorkspaces: suspended,
    verifiedDomains: verified,
    totalDomains: domainsTotal,
    emailsSubmitted: settled,
    emailsReserved: reserved,
    delivery: { delivered, negative, rate: denom > 0 ? delivered / denom : null },
    month,
  };
});

// ---- workspace table --------------------------------------------------------------------
export type AdminWorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  status: WorkspaceRow["status"];
  domains: { id: string; hostname: string; send_status: DomainStatus; inbound_status: InboundDomainStatus }[];
  verification: Verification;
  used: number;
  limit: number;
  members: number;
};

export const listAdminWorkspaces = cache(async (): Promise<AdminWorkspaceRow[]> => {
  const admin = await adminOnly();
  const month = currentYearMonth();
  const [ws, domains, usage, members] = await Promise.all([
    admin.from("workspaces").select("*").order("name"),
    admin.from("domains").select("id, workspace_id, hostname, send_status, inbound_status").order("hostname"),
    admin.from("monthly_usage").select("workspace_id, settled_count, reserved_count").eq("year_month", month),
    admin.from("workspace_memberships").select("workspace_id"),
  ]);
  for (const r of [ws, domains, usage, members]) if (r.error) throw new Error(r.error.message);
  const usageBy = new Map((usage.data ?? []).map((u) => [u.workspace_id, u.settled_count + u.reserved_count]));
  const memberCount = new Map<string, number>();
  for (const m of members.data ?? []) memberCount.set(m.workspace_id, (memberCount.get(m.workspace_id) ?? 0) + 1);
  return (ws.data ?? []).map((w) => {
    const ds = (domains.data ?? []).filter((d) => d.workspace_id === w.id);
    return {
      id: w.id,
      name: w.name,
      slug: w.slug,
      status: w.status,
      domains: ds,
      verification: summarizeVerification(ds),
      used: usageBy.get(w.id) ?? 0,
      limit: w.monthly_sending_limit,
      members: memberCount.get(w.id) ?? 0,
    };
  });
});

// ---- volume chart ------------------------------------------------------------------------
export type VolumePoint = { yearMonth: string; settled: number; reserved: number };

export const getVolumeSeries = cache(async (months = 6): Promise<VolumePoint[]> => {
  const admin = await adminOnly();
  const keys = lastYearMonths(months);
  const { data, error } = await admin
    .from("monthly_usage")
    .select("year_month, settled_count, reserved_count")
    .in("year_month", keys);
  if (error) throw new Error(error.message);
  return keys.map((yearMonth) => {
    const rows = (data ?? []).filter((r) => r.year_month === yearMonth);
    return {
      yearMonth,
      settled: rows.reduce((n, r) => n + r.settled_count, 0),
      reserved: rows.reduce((n, r) => n + r.reserved_count, 0),
    };
  });
});

// ---- needs attention ----------------------------------------------------------------------
export type AttentionItem = {
  kind: "dns" | "limit" | "outbox";
  workspaceId: string;
  workspaceName: string;
  title: string;
  detail: string;
  severity: "danger" | "warn";
};

export const LIMIT_WARN_RATIO = 0.8;

export const getAttention = cache(async (): Promise<AttentionItem[]> => {
  const admin = await adminOnly();
  const workspaces = await listAdminWorkspaces();
  const items: AttentionItem[] = [];

  for (const w of workspaces) {
    for (const d of w.domains) {
      const bad: string[] = [];
      if (isFailingStatus(d.send_status)) bad.push(`outbound ${d.send_status.replace(/_/g, " ")}`);
      if (isFailingStatus(d.inbound_status)) bad.push(`inbound ${d.inbound_status.replace(/_/g, " ")}`);
      if (bad.length) {
        items.push({ kind: "dns", workspaceId: w.id, workspaceName: w.name, severity: "danger", title: `DNS failing for ${d.hostname}`, detail: bad.join(", ") });
      }
    }
    if (w.limit > 0 && w.used / w.limit >= LIMIT_WARN_RATIO && w.status === "active") {
      const over = w.used >= w.limit;
      items.push({
        kind: "limit",
        workspaceId: w.id,
        workspaceName: w.name,
        severity: over ? "danger" : "warn",
        title: over ? "Monthly limit reached" : "Approaching monthly limit",
        detail: `${w.used.toLocaleString("en-US")} of ${w.limit.toLocaleString("en-US")} used (${Math.round((w.used / w.limit) * 100)}%)`,
      });
    }
  }

  const { data: jobs, error } = await admin
    .from("outbox_jobs")
    .select("workspace_id, status, last_error, updated_at")
    .in("status", ["failed", "dead"] satisfies OutboxStatus[])
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  const byWs = new Map<string, { n: number; last: string | null }>();
  for (const j of jobs ?? []) {
    const cur = byWs.get(j.workspace_id) ?? { n: 0, last: j.last_error };
    cur.n += 1;
    byWs.set(j.workspace_id, cur);
  }
  const names = new Map(workspaces.map((w) => [w.id, w.name]));
  for (const [workspaceId, v] of byWs) {
    items.push({
      kind: "outbox",
      workspaceId,
      workspaceName: names.get(workspaceId) ?? "Workspace",
      severity: "danger",
      title: `${v.n} failed outbound ${v.n === 1 ? "job" : "jobs"}`,
      detail: v.last ? `Latest error: ${v.last.slice(0, 120)}` : "No error recorded",
    });
  }
  return items.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "danger" ? -1 : 1));
});

// ---- registered users -----------------------------------------------------------------------
export type AdminUserRow = {
  id: string;
  email: string;
  fullName: string | null;
  createdAt: string;
  isPlatformAdmin: boolean;
  memberships: { workspaceId: string; workspaceName: string; workspaceSlug: string; role: WorkspaceRole }[];
};

/** Every signed-up profile (auth.users → profiles), with workspace memberships. No message content. */
export const listAdminUsers = cache(async (): Promise<AdminUserRow[]> => {
  const admin = await adminOnly();
  const [profiles, memberships, workspaces, platformAdmins] = await Promise.all([
    admin.from("profiles").select("id, email, full_name, created_at").order("created_at", { ascending: false }),
    admin.from("workspace_memberships").select("user_id, workspace_id, role"),
    admin.from("workspaces").select("id, name, slug"),
    admin.from("platform_admins").select("user_id"),
  ]);
  for (const r of [profiles, memberships, workspaces, platformAdmins]) {
    if (r.error) throw new Error(r.error.message);
  }

  const wsById = new Map((workspaces.data ?? []).map((w) => [w.id, w]));
  const adminSet = new Set((platformAdmins.data ?? []).map((p) => p.user_id));
  const membershipsByUser = new Map<string, AdminUserRow["memberships"]>();
  for (const m of memberships.data ?? []) {
    const ws = wsById.get(m.workspace_id);
    if (!ws) continue;
    const list = membershipsByUser.get(m.user_id) ?? [];
    list.push({
      workspaceId: ws.id,
      workspaceName: ws.name,
      workspaceSlug: ws.slug,
      role: m.role,
    });
    membershipsByUser.set(m.user_id, list);
  }

  return (profiles.data ?? []).map((p) => ({
    id: p.id,
    email: p.email,
    fullName: p.full_name,
    createdAt: p.created_at,
    isPlatformAdmin: adminSet.has(p.id),
    memberships: (membershipsByUser.get(p.id) ?? []).sort((a, b) => a.workspaceName.localeCompare(b.workspaceName)),
  }));
});

export type AdminPendingInviteRow = {
  id: string;
  email: string;
  role: InvitationRole;
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  expiresAt: string;
  createdAt: string;
};

/** Open workspace invitations across all clients (invited, not yet accepted). */
export const listAdminPendingInvitations = cache(async (): Promise<AdminPendingInviteRow[]> => {
  const admin = await adminOnly();
  const now = new Date().toISOString();
  const [invites, workspaces] = await Promise.all([
    admin
      .from("workspace_invitations")
      .select("id, email, role, workspace_id, expires_at, created_at")
      .is("accepted_at", null)
      .is("revoked_at", null)
      .gt("expires_at", now)
      .order("created_at", { ascending: false }),
    admin.from("workspaces").select("id, name, slug"),
  ]);
  if (invites.error) throw new Error(invites.error.message);
  if (workspaces.error) throw new Error(workspaces.error.message);
  const wsById = new Map((workspaces.data ?? []).map((w) => [w.id, w]));
  const out: AdminPendingInviteRow[] = [];
  for (const i of invites.data ?? []) {
    const ws = wsById.get(i.workspace_id);
    if (!ws) continue;
    out.push({
      id: i.id,
      email: i.email,
      role: i.role,
      workspaceId: ws.id,
      workspaceName: ws.name,
      workspaceSlug: ws.slug,
      expiresAt: i.expires_at,
      createdAt: i.created_at,
    });
  }
  return out;
});

// ---- workspace detail -----------------------------------------------------------------------
export type AdminWorkspaceDetail = {
  workspace: WorkspaceRow;
  domains: DomainRow[];
  members: { membershipId: string; userId: string; role: WorkspaceRole; email: string; fullName: string | null; joinedAt: string }[];
  invitations: { id: string; email: string; role: string; expiresAt: string; createdAt: string }[];
  quota: QuotaStatus;
  history: { yearMonth: string; settled: number; reserved: number }[];
  outbox: Record<OutboxStatus, number>;
  mailboxCount: number;
  audit: (Pick<AuditLogRow, "id" | "action" | "resource_type" | "created_at" | "metadata"> & { actor: string | null })[];
  hasOwner: boolean;
};

export async function getAdminWorkspaceDetail(id: string): Promise<AdminWorkspaceDetail | null> {
  const admin = await adminOnly();
  const { data: workspace, error } = await admin.from("workspaces").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!workspace) return null;
  const keys = lastYearMonths(6);

  const [domains, memberships, invites, usage, jobs, mailboxes, audit] = await Promise.all([
    admin.from("domains").select("*").eq("workspace_id", id).order("hostname"),
    admin.from("workspace_memberships").select("id, user_id, role, created_at").eq("workspace_id", id),
    admin
      .from("workspace_invitations")
      .select("id, email, role, expires_at, created_at")
      .eq("workspace_id", id)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString()),
    admin.from("monthly_usage").select("year_month, settled_count, reserved_count").eq("workspace_id", id).in("year_month", keys),
    admin.from("outbox_jobs").select("status").eq("workspace_id", id),
    admin.from("mailboxes").select("id", { count: "exact", head: true }).eq("workspace_id", id),
    admin.from("audit_logs").select("id, action, resource_type, created_at, metadata, actor_user_id").eq("workspace_id", id).order("created_at", { ascending: false }).limit(15),
  ]);

  const userIds = [...new Set([...(memberships.data ?? []).map((m) => m.user_id), ...(audit.data ?? []).map((a) => a.actor_user_id).filter((x): x is string => !!x)])];
  const { data: profiles } = userIds.length ? await admin.from("profiles").select("id, email, full_name").in("id", userIds) : { data: [] };
  const profile = new Map((profiles ?? []).map((p) => [p.id, p]));

  const outbox: Record<OutboxStatus, number> = { pending: 0, processing: 0, succeeded: 0, failed: 0, dead: 0 };
  for (const j of jobs.data ?? []) outbox[j.status] += 1;

  const current = (usage.data ?? []).find((u) => u.year_month === currentYearMonth());
  const members = (memberships.data ?? []).map((m) => ({
    membershipId: m.id,
    userId: m.user_id,
    role: m.role,
    email: profile.get(m.user_id)?.email ?? "unknown",
    fullName: profile.get(m.user_id)?.full_name ?? null,
    joinedAt: m.created_at,
  }));

  return {
    workspace,
    domains: domains.data ?? [],
    members,
    invitations: (invites.data ?? []).map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expires_at, createdAt: i.created_at })),
    quota: summarizeQuota(workspace.monthly_sending_limit, current?.reserved_count ?? 0, current?.settled_count ?? 0, currentYearMonth()),
    history: keys.map((yearMonth) => {
      const r = (usage.data ?? []).find((u) => u.year_month === yearMonth);
      return { yearMonth, settled: r?.settled_count ?? 0, reserved: r?.reserved_count ?? 0 };
    }),
    outbox,
    mailboxCount: mailboxes.count ?? 0,
    audit: (audit.data ?? []).map((a) => ({
      id: a.id,
      action: a.action,
      resource_type: a.resource_type,
      created_at: a.created_at,
      metadata: a.metadata,
      actor: a.actor_user_id ? (profile.get(a.actor_user_id)?.email ?? "unknown") : null,
    })),
    hasOwner: members.some((m) => m.role === "owner"),
  };
}
