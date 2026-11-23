import { requireMailboxAccess } from "@/lib/auth/authz";
import type {
  AudienceContactRow,
  AudienceListRow,
  CampaignRecipientRow,
  CampaignRow,
} from "@/lib/types/database";
import { getReadableMailboxes, getWorkspaceContext, type WorkspaceContext } from "./workspace";

export async function listAudienceLists(ctx: WorkspaceContext): Promise<(AudienceListRow & { contactCount: number })[]> {
  const { data, error } = await ctx.supabase
    .from("audience_lists")
    .select("*")
    .eq("workspace_id", ctx.workspace.id)
    .order("name");
  if (error) throw new Error(error.message);
  const lists = data ?? [];
  if (!lists.length) return [];
  const counts = await Promise.all(
    lists.map(async (l) => {
      const { count } = await ctx.supabase
        .from("audience_contacts")
        .select("id", { count: "exact", head: true })
        .eq("list_id", l.id);
      return count ?? 0;
    }),
  );
  return lists.map((l, i) => ({ ...l, contactCount: counts[i]! }));
}

export async function getAudienceList(
  ctx: WorkspaceContext,
  listId: string,
): Promise<{ list: AudienceListRow; contacts: AudienceContactRow[] } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(listId)) return null;
  const { data: list } = await ctx.supabase
    .from("audience_lists")
    .select("*")
    .eq("id", listId)
    .eq("workspace_id", ctx.workspace.id)
    .maybeSingle();
  if (!list) return null;
  const { data: contacts, error } = await ctx.supabase
    .from("audience_contacts")
    .select("*")
    .eq("list_id", listId)
    .order("email")
    .limit(500);
  if (error) throw new Error(error.message);
  return { list, contacts: contacts ?? [] };
}

export async function listCampaigns(ctx: WorkspaceContext): Promise<(CampaignRow & { listName: string; mailboxAddress: string })[]> {
  const { data, error } = await ctx.supabase
    .from("campaigns")
    .select("*")
    .eq("workspace_id", ctx.workspace.id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  if (!rows.length) return [];
  const listIds = [...new Set(rows.map((r) => r.list_id))];
  const mailboxIds = [...new Set(rows.map((r) => r.mailbox_id))];
  const [{ data: lists }, { data: mailboxes }] = await Promise.all([
    ctx.supabase.from("audience_lists").select("id, name").in("id", listIds),
    ctx.supabase.from("mailboxes").select("id, address").in("id", mailboxIds),
  ]);
  const listName = new Map((lists ?? []).map((l) => [l.id, l.name]));
  const mbAddr = new Map((mailboxes ?? []).map((m) => [m.id, m.address]));
  return rows.map((r) => ({
    ...r,
    listName: listName.get(r.list_id) ?? "—",
    mailboxAddress: mbAddr.get(r.mailbox_id) ?? "—",
  }));
}

export async function getCampaign(
  ctx: WorkspaceContext,
  campaignId: string,
): Promise<{
  campaign: CampaignRow;
  listName: string;
  mailboxAddress: string;
  recipients: CampaignRecipientRow[];
  canSend: boolean;
} | null> {
  if (!/^[0-9a-f-]{36}$/i.test(campaignId)) return null;
  const { data: campaign } = await ctx.supabase
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .eq("workspace_id", ctx.workspace.id)
    .maybeSingle();
  if (!campaign) return null;

  const [{ data: list }, { data: mailbox }, { data: recipients }] = await Promise.all([
    ctx.supabase.from("audience_lists").select("name").eq("id", campaign.list_id).maybeSingle(),
    ctx.supabase.from("mailboxes").select("address").eq("id", campaign.mailbox_id).maybeSingle(),
    ctx.supabase
      .from("campaign_recipients")
      .select("*")
      .eq("campaign_id", campaignId)
      .order("created_at")
      .limit(200),
  ]);

  let canSend = false;
  try {
    const access = await requireMailboxAccess(ctx.supabase, ctx.user.id, campaign.mailbox_id, "send");
    canSend = access.permission === "read_send" && access.mailbox.enabled;
  } catch {
    canSend = false;
  }

  return {
    campaign,
    listName: list?.name ?? "—",
    mailboxAddress: mailbox?.address ?? "—",
    recipients: recipients ?? [],
    canSend,
  };
}

export async function getCampaignFormOptions(slug: string) {
  const ctx = await getWorkspaceContext(slug);
  const [lists, mailboxes, templates] = await Promise.all([
    listAudienceLists(ctx),
    getReadableMailboxes(slug),
    ctx.supabase
      .from("email_templates")
      .select("id, name, subject, body_text")
      .eq("workspace_id", ctx.workspace.id)
      .order("name"),
  ]);
  return {
    ctx,
    lists,
    sendMailboxes: mailboxes.filter((m) => m.permission === "read_send" && m.enabled),
    templates: templates.data ?? [],
  };
}
