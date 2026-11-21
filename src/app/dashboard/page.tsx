import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Inbox, ShieldCheck } from "lucide-react";
import { Brand } from "@/components/layout/brand";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { SubmitButton } from "@/components/ui/submit-button";
import { signOutAction } from "@/lib/actions/auth";
import { getCurrentUser, getIsPlatformAdmin, getUserWorkspaces, requireUser } from "@/lib/auth/session";
import { one } from "@/lib/format";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-xl px-5 py-24">
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      <DashboardRouter />
    </Suspense>
  );
}

async function DashboardRouter() {
  await requireUser("/dashboard");
  const memberships = await getUserWorkspaces();
  const workspaces = memberships
    .map((m) => ({ role: m.role, ws: one(m.workspace as unknown as { id: string; name: string; slug: string; status: string } | null) }))
    .filter((m): m is { role: typeof m.role; ws: NonNullable<typeof m.ws> } => m.ws !== null)
    .sort((a, b) => a.ws.name.localeCompare(b.ws.name));

  if (workspaces.length > 0) redirect(`/w/${workspaces[0].ws.slug}/inbox`);
  // Platform superusers manage clients from /admin; they need no workspace membership.
  if (await getIsPlatformAdmin()) redirect("/admin");
  return <NoWorkspace />;
}

async function NoWorkspace() {
  const [user, isAdmin] = await Promise.all([getCurrentUser(), getIsPlatformAdmin()]);
  const email = user?.email?.toLowerCase() ?? "";

  // Pending invitations addressed to this (verified) email.
  let pending: { token?: never; workspace: string; role: string; expires: string }[] = [];
  if (email && user?.email_confirmed_at) {
    const admin = createAdminClient();
    const { data } = await admin
      .from("workspace_invitations")
      .select("workspace_id, role, expires_at")
      .eq("email", email)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString());
    if (data?.length) {
      const { data: names } = await admin.from("workspaces").select("id, name").in("id", data.map((d) => d.workspace_id));
      const byId = new Map((names ?? []).map((n) => [n.id, n.name]));
      pending = data.map((d) => ({ workspace: byId.get(d.workspace_id) ?? "A workspace", role: d.role, expires: d.expires_at }));
    }
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-5 py-16">
      <Brand className="mb-8" />
      <Panel>
        <EmptyState
          icon={Inbox}
          title="You're not in a workspace yet"
          description={
            <>
              Workspaces are created by the platform team for each client. Ask your workspace owner to invite{" "}
              <strong className="font-medium text-ink">{email}</strong>, then open the invitation link they send you.
            </>
          }
        />
        {pending.length ? (
          <div className="border-t border-line px-6 py-4 text-sm">
            <p className="font-medium text-ink">Pending invitations for you</p>
            <ul className="mt-2 space-y-1.5">
              {pending.map((p, i) => (
                <li key={i} className="flex items-center justify-between gap-3">
                  <span>{p.workspace}</span>
                  <Badge tone="accent">{p.role}</Badge>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted">Open the link in your invitation message to accept — links are single-use.</p>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-6 py-4">
          {isAdmin ? (
            <LinkButton href="/admin" variant="primary" size="sm">
              <ShieldCheck className="size-4" aria-hidden /> Open admin console
            </LinkButton>
          ) : (
            <Link href="/" className="text-sm text-muted hover:text-ink">
              ← Back to home
            </Link>
          )}
          <form action={signOutAction}>
            <SubmitButton variant="ghost" size="sm">
              Sign out
            </SubmitButton>
          </form>
        </div>
      </Panel>
    </div>
  );
}
