"use server";

import { revalidatePath } from "next/cache";
import { writeAudit } from "@/lib/audit";
import { HOSTNAME_RE, normalizeHostname, statusesFromProvider } from "@/lib/domains";
import { requireDomainManager } from "@/lib/data/workspace";
import { getEmailAdapter, ProviderRequestError } from "@/lib/resend";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/types/database";
import { formString, guarded } from "./guard";
import { fail, ok, type ActionState } from "./state";

function revalidateDomainViews(workspaceId: string, slug: string) {
  revalidatePath(`/w/${slug}/settings/domains`);
  revalidatePath(`/admin/workspaces/${workspaceId}`);
  revalidatePath("/admin");
}

/**
 * Register a sending/receiving domain with the provider and store its DNS
 * records. Allowed for platform admins (client onboarding) and workspace
 * owners/admins. Neither role grants any mailbox/message access.
 */
export async function addDomainAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return guarded(async () => {
    const workspaceId = formString(formData, "workspaceId");
    const hostname = normalizeHostname(formString(formData, "hostname"));
    const { user, workspace } = await requireDomainManager(workspaceId);

    if (!HOSTNAME_RE.test(hostname)) {
      return fail("Enter a valid domain such as mail.example.com.", { hostname: "Not a valid hostname" });
    }
    const admin = createAdminClient();
    const { data: taken } = await admin.from("domains").select("id").eq("hostname", hostname).maybeSingle();
    if (taken) return fail("That domain is already registered.", { hostname: "Already in use" });

    const adapter = getEmailAdapter();
    let provider;
    try {
      provider = await adapter.createDomain({ hostname, enableReceiving: true });
    } catch (e) {
      if (e instanceof ProviderRequestError) return fail(`The email provider rejected that domain: ${e.message}`);
      throw e;
    }
    const s = statusesFromProvider(provider);
    const { data: row, error } = await admin
      .from("domains")
      .insert({
        workspace_id: workspace.id,
        hostname,
        resend_domain_id: provider.providerDomainId,
        send_status: s.send,
        inbound_status: s.inbound,
        dns_records: provider.records as unknown as Json,
        last_checked_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !row) {
      await adapter.deleteDomain(provider.providerDomainId).catch(() => undefined);
      throw new Error(error?.message ?? "domain insert failed");
    }
    await writeAudit(admin, {
      workspaceId: workspace.id,
      actorUserId: user.id,
      action: "domain.added",
      resourceType: "domain",
      resourceId: row.id,
      metadata: { hostname, adapter: adapter.mode },
    });
    revalidateDomainViews(workspace.id, workspace.slug);
    return ok(`Added ${hostname}. Publish the DNS records below, then recheck.`);
  });
}

/** Ask the provider to re-verify DNS and refresh both readiness columns. */
export async function recheckDomainAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return guarded(async () => {
    const domainId = formString(formData, "domainId");
    const admin = createAdminClient();
    const { data: domain } = await admin.from("domains").select("*").eq("id", domainId).maybeSingle();
    if (!domain) return fail("Domain not found.");
    const { user, workspace } = await requireDomainManager(domain.workspace_id);
    if (!domain.resend_domain_id) return fail("This domain isn't linked to the email provider yet.");

    const adapter = getEmailAdapter();
    try {
      const provider = await adapter.verifyDomain(domain.resend_domain_id);
      const s = statusesFromProvider(provider);
      await admin
        .from("domains")
        .update({
          send_status: s.send,
          inbound_status: s.inbound,
          dns_records: provider.records as unknown as Json,
          last_checked_at: new Date().toISOString(),
        })
        .eq("id", domain.id);
    } catch (e) {
      if (e instanceof ProviderRequestError) {
        if (adapter.mode === "mock" && e.statusCode === 404) {
          // Seeded demo domains aren't in the in-memory mock provider.
          await admin.from("domains").update({ last_checked_at: new Date().toISOString() }).eq("id", domain.id);
          revalidateDomainViews(workspace.id, workspace.slug);
          return ok("Demo mode: this domain's records are simulated, so there is nothing new to verify.");
        }
        return fail(`Recheck failed: ${e.message}`);
      }
      throw e;
    }
    await writeAudit(admin, {
      workspaceId: workspace.id,
      actorUserId: user.id,
      action: "domain.rechecked",
      resourceType: "domain",
      resourceId: domain.id,
      metadata: { hostname: domain.hostname },
    });
    revalidateDomainViews(workspace.id, workspace.slug);
    return ok("DNS rechecked.");
  });
}

/**
 * Remove a domain from Mail Console and (best-effort) from the email provider.
 * Cascades to mailboxes on that domain (and their threads/messages) via FK.
 */
export async function deleteDomainAction(formData: FormData): Promise<void> {
  const domainId = formString(formData, "domainId");
  const admin = createAdminClient();
  const { data: domain } = await admin.from("domains").select("*").eq("id", domainId).maybeSingle();
  if (!domain) throw new Error("Domain not found");
  const { user, workspace } = await requireDomainManager(domain.workspace_id);

  if (domain.resend_domain_id) {
    const adapter = getEmailAdapter();
    try {
      await adapter.deleteDomain(domain.resend_domain_id);
    } catch (e) {
      // Provider 404 = already gone; other errors still allow local cleanup so
      // the mistaken vercel.app domain can be removed even if Resend disagrees.
      if (!(e instanceof ProviderRequestError && e.statusCode === 404)) {
        console.error(`[domain.delete] provider remove failed for ${domain.hostname}:`, e);
      }
    }
  }

  const { error } = await admin.from("domains").delete().eq("id", domain.id).eq("workspace_id", workspace.id);
  if (error) throw new Error(error.message);

  await writeAudit(admin, {
    workspaceId: workspace.id,
    actorUserId: user.id,
    action: "domain.deleted",
    resourceType: "domain",
    resourceId: domain.id,
    metadata: { hostname: domain.hostname },
  });
  revalidateDomainViews(workspace.id, workspace.slug);
}
