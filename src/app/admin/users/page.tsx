import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Mail, Users } from "lucide-react";
import { Suspense } from "react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, Panel, PanelHeader } from "@/components/ui/panel";
import { SkeletonRows } from "@/components/ui/skeleton";
import { listAdminPendingInvitations, listAdminUsers } from "@/lib/data/admin";
import { first, formatFullDate, formatNumber, formatRelative } from "@/lib/format";

export const metadata: Metadata = { title: "Users" };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default function AdminUsersPage({ searchParams }: { searchParams: SP }) {
  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Users"
        description="Registered accounts and pending workspace invitations. Message content is never shown here."
      />
      <Suspense fallback={<SkeletonRows rows={8} />}>
        <Body searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Body({ searchParams }: { searchParams: SP }) {
  await connection();
  const sp = await searchParams;
  const q = (first(sp.q) ?? "").trim().toLowerCase();
  const [users, pending] = await Promise.all([listAdminUsers(), listAdminPendingInvitations()]);

  const filteredUsers = q
    ? users.filter(
        (u) =>
          u.email.includes(q) ||
          (u.fullName?.toLowerCase().includes(q) ?? false) ||
          u.memberships.some((m) => m.workspaceName.toLowerCase().includes(q) || m.workspaceSlug.includes(q)),
      )
    : users;

  const filteredPending = q
    ? pending.filter(
        (i) =>
          i.email.includes(q) ||
          i.workspaceName.toLowerCase().includes(q) ||
          i.workspaceSlug.includes(q) ||
          i.role.includes(q),
      )
    : pending;

  return (
    <div className="space-y-6">
      <form method="get" action="/admin/users" className="flex flex-wrap items-center gap-2">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search email, name, or workspace…"
          className="h-9 w-full max-w-md rounded-md border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
        />
        <button type="submit" className="h-9 rounded-md bg-accent px-3 text-sm font-medium text-white hover:bg-accent-hover">
          Search
        </button>
        {q ? (
          <Link href="/admin/users" className="text-[13px] text-muted hover:text-ink">
            Clear
          </Link>
        ) : null}
      </form>

      <Panel>
        <PanelHeader
          title="Pending invitations"
          description={`${formatNumber(filteredPending.length)}${q ? ` matching` : ""} open · invited, not yet accepted`}
        />
        {filteredPending.length === 0 ? (
          <EmptyState
            icon={Mail}
            title={q ? "No matching invitations" : "No pending invitations"}
            description={q ? "Try a different search." : "Invites appear here until someone accepts or they expire."}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="border-b border-line bg-surface-muted/50 text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Email</th>
                  <th className="px-5 py-2.5 font-medium">Workspace</th>
                  <th className="px-5 py-2.5 font-medium">Role</th>
                  <th className="px-5 py-2.5 font-medium">Invited</th>
                  <th className="px-5 py-2.5 font-medium">Expires</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filteredPending.map((i) => (
                  <tr key={i.id}>
                    <td className="px-5 py-3">
                      <span className="font-medium text-ink">{i.email}</span>
                      <Badge tone="warn" className="ml-2">
                        Pending
                      </Badge>
                    </td>
                    <td className="px-5 py-3">
                      <Link href={`/admin/workspaces/${i.workspaceId}`} className="font-medium text-ink hover:text-accent">
                        {i.workspaceName}
                      </Link>
                    </td>
                    <td className="px-5 py-3">
                      <Badge tone={i.role === "owner" ? "accent" : "neutral"}>{i.role}</Badge>
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-[13px] text-muted">{formatRelative(i.createdAt)}</td>
                    <td className="whitespace-nowrap px-5 py-3 text-[13px] text-muted">{formatFullDate(i.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel>
        <PanelHeader
          title="Registered accounts"
          description={`${formatNumber(filteredUsers.length)}${q ? ` matching “${q}”` : ""} of ${formatNumber(users.length)} signed up`}
        />
        {filteredUsers.length === 0 ? (
          <EmptyState
            icon={Users}
            title={q ? "No matching users" : "No registered users yet"}
            description={q ? "Try a different search." : "Accounts appear here after signup."}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="border-b border-line bg-surface-muted/50 text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-5 py-2.5 font-medium">User</th>
                  <th className="px-5 py-2.5 font-medium">Workspaces</th>
                  <th className="px-5 py-2.5 font-medium">Joined</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filteredUsers.map((u) => (
                  <tr key={u.id} className="align-top">
                    <td className="px-5 py-3">
                      <p className="font-medium text-ink">{u.fullName ?? u.email}</p>
                      {u.fullName ? <p className="text-[13px] text-muted">{u.email}</p> : null}
                      {u.isPlatformAdmin ? (
                        <Badge tone="accent" className="mt-1.5">
                          Platform admin
                        </Badge>
                      ) : null}
                    </td>
                    <td className="px-5 py-3">
                      {u.memberships.length === 0 ? (
                        <span className="text-[13px] text-muted">No workspace membership</span>
                      ) : (
                        <ul className="space-y-1.5">
                          {u.memberships.map((m) => (
                            <li key={`${u.id}-${m.workspaceId}`} className="flex flex-wrap items-center gap-2">
                              <Link href={`/admin/workspaces/${m.workspaceId}`} className="font-medium text-ink hover:text-accent">
                                {m.workspaceName}
                              </Link>
                              <Badge tone={m.role === "owner" ? "accent" : "neutral"}>{m.role}</Badge>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-[13px] text-muted">{formatRelative(u.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
