import { cache } from "react";
import { canAccessSection, type SettingsSection } from "@/lib/settings-access";
import { currentYearMonth, getQuotaStatus } from "@/lib/email/quota";
import { lastYearMonths } from "@/lib/format";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  DomainRow,
  EmailTemplateRow,
  MailboxPermission,
  OutboxStatus,
  WorkspaceRole,
} from "@/lib/types/database";
import { getWorkspaceContext, type WorkspaceContext } from "./workspace";

export type SectionGate = { allowed: true; ctx: WorkspaceContext } | { allowed: false; ctx: WorkspaceContext };

/** Server-side gate for a settings page. Hiding a nav item is cosmetic; this is the check. */
export async function gateSection(slug: string, section: SettingsSection): Promise<SectionGate> {
  const ctx = await getWorkspaceContext(slug);
  return { allowed: canAccessSection(ctx.role, section), ctx };
}

// ---- domains --------------------------------------------------------------------------
export async function getDomains(ctx: WorkspaceContext): Promise<DomainRow[]> {
  const { data, error } = await ctx.supabase.from("domains").select("*").eq("workspace_id", ctx.workspace.id).order("hostname");
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Mailbox counts per domain (for delete confirmation). Metadata only. */
export async function getDomainMailboxCounts(workspaceId: string): Promise<Record<string, number>> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("mailboxes").select("domain_id").eq("workspace_id", workspaceId);
  if (error) throw new Error(error.message);
  const counts: Record<string, number> = {};
  for (const row of data ?? []) counts[row.domain_id] = (counts[row.domain_id] ?? 0) + 1;
  return counts;
}

// ---- mailboxes & grants ---------------------------------------------------------------------
export type MemberRow = { membershipId: string; userId: string; role: WorkspaceRole; email: string; fullName: string | null; createdAt: string };

export const getMembers = cache(async (workspaceId: string): Promise<MemberRow[]> => {
  const admin = createAdminClient();
  const { data: ms, error } = await admin
    .from("workspace_memberships")
    .select("id, user_id, role, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at");
  if (error) throw new Error(error.message);
  const ids = (ms ?? []).map((m) => m.user_id);
  const { data: profiles } = ids.length ? await admin.from("profiles").select("id, email, full_name").in("id", ids) : { data: [] };
  const byId = new Map((profiles ?? []).map((p) => [p.id, p]));
  return (ms ?? []).map((m) => ({
    membershipId: m.id,
    userId: m.user_id,
    role: m.role,
    email: byId.get(m.user_id)?.email ?? "unknown",
    fullName: byId.get(m.user_id)?.full_name ?? null,
    createdAt: m.created_at,
  }));
});

export type MailboxAdminRow = {
  id: string;
  address: string;
  displayName: string | null;
  enabled: boolean;
  domainHostname: string;
  grants: Record<string, MailboxPermission>; // membershipId -> permission
};

/**
 * ALL mailboxes of the workspace (metadata only) for owners/admins managing
 * grants. Uses the service role because RLS hides mailboxes you aren't granted
 * — callers must have passed gateSection("mailboxes") first. No message data is read.
 */
export async function getMailboxAdminData(workspaceId: string): Promise<{ mailboxes: MailboxAdminRow[]; members: MemberRow[]; domains: Pick<DomainRow, "id" | "hostname">[] }> {
  const admin = createAdminClient();
  const [mb, grants, domains, members] = await Promise.all([
    admin.from("mailboxes").select("id, address, display_name, enabled, domain_id").eq("workspace_id", workspaceId).order("address"),
    admin.from("mailbox_access").select("mailbox_id, membership_id, permission").eq("workspace_id", workspaceId),
    admin.from("domains").select("id, hostname").eq("workspace_id", workspaceId).order("hostname"),
    getMembers(workspaceId),
  ]);
  for (const r of [mb, grants, domains]) if (r.error) throw new Error(r.error.message);
  const host = new Map((domains.data ?? []).map((d) => [d.id, d.hostname]));
  return {
    members,
    domains: domains.data ?? [],
    mailboxes: (mb.data ?? []).map((m) => ({
      id: m.id,
      address: m.address,
      displayName: m.display_name,
      enabled: m.enabled,
      domainHostname: host.get(m.domain_id) ?? "",
      grants: Object.fromEntries((grants.data ?? []).filter((g) => g.mailbox_id === m.id).map((g) => [g.membership_id, g.permission])),
    })),
  };
}

// ---- team --------------------------------------------------------------------------------------
export async function getPendingInvitations(ctx: WorkspaceContext) {
  const { data, error } = await ctx.supabase
    .from("workspace_invitations")
    .select("id, email, role, expires_at, created_at")
    .eq("workspace_id", ctx.workspace.id)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

// ---- templates -----------------------------------------------------------------------------------
export async function getTemplates(ctx: WorkspaceContext): Promise<EmailTemplateRow[]> {
  const { data, error } = await ctx.supabase.from("email_templates").select("*").eq("workspace_id", ctx.workspace.id).order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
}

// ---- integrations ------------------------------------------------------------------------------------
export async function getIntegrations(ctx: WorkspaceContext) {
  const { data, error } = await ctx.supabase
    .from("app_integrations")
    .select("id, name, allowed_mailbox_id, key_prefix, last_used_at, revoked_at, created_at")
    .eq("workspace_id", ctx.workspace.id)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}

// ---- usage ---------------------------------------------------------------------------------------------
export async function getUsage(ctx: WorkspaceContext) {
  const keys = lastYearMonths(6);
  const admin = createAdminClient(); // authz done by caller (member of this workspace)
  const [quota, hist] = await Promise.all([
    getQuotaStatus(admin, ctx.workspace.id),
    ctx.supabase.from("monthly_usage").select("year_month, settled_count, reserved_count").eq("workspace_id", ctx.workspace.id).in("year_month", keys),
  ]);
  const history = keys.map((yearMonth) => {
    const r = (hist.data ?? []).find((x) => x.year_month === yearMonth);
    return { yearMonth, settled: r?.settled_count ?? 0, reserved: r?.reserved_count ?? 0 };
  });
  return { quota, history, month: currentYearMonth() };
}

export async function getAdminUsageExtras(ctx: WorkspaceContext) {
  const [jobs, audit] = await Promise.all([
    ctx.supabase.from("outbox_jobs").select("status").eq("workspace_id", ctx.workspace.id),
    ctx.supabase
      .from("audit_logs")
      .select("id, action, resource_type, created_at, actor_user_id")
      .eq("workspace_id", ctx.workspace.id)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  const outbox: Record<OutboxStatus, number> = { pending: 0, processing: 0, succeeded: 0, failed: 0, dead: 0 };
  for (const j of jobs.data ?? []) outbox[j.status] += 1;
  const actorIds = [...new Set((audit.data ?? []).map((a) => a.actor_user_id).filter((x): x is string => !!x))];
  const { data: profiles } = actorIds.length ? await ctx.supabase.from("profiles").select("id, email").in("id", actorIds) : { data: [] };
  const email = new Map((profiles ?? []).map((p) => [p.id, p.email]));
  return {
    outbox,
    audit: (audit.data ?? []).map((a) => ({ id: a.id, action: a.action, createdAt: a.created_at, actor: a.actor_user_id ? (email.get(a.actor_user_id) ?? "unknown") : "system" })),
  };
}
