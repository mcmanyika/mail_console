"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import type { AdminUserRow } from "@/lib/data/admin";
import { formatFullDate, formatRelative } from "@/lib/format";

export function AdminUsersTable({ users }: { users: AdminUserRow[] }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<AdminUserRow | null>(null);

  const open = (user: AdminUserRow) => {
    setSelected(user);
    dialogRef.current?.showModal();
  };

  const close = () => {
    dialogRef.current?.close();
  };

  return (
    <>
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
            {users.map((u) => (
              <tr
                key={u.id}
                tabIndex={0}
                role="button"
                aria-label={`View details for ${u.fullName ?? u.email}`}
                onClick={() => open(u)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    open(u);
                  }
                }}
                className="cursor-pointer align-top transition-colors hover:bg-canvas-deep/60 focus-visible:bg-canvas-deep/60 focus-visible:outline-none"
              >
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
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{u.memberships[0].workspaceName}</span>
                      <Badge tone={u.memberships[0].role === "owner" ? "accent" : "neutral"}>
                        {u.memberships[0].role}
                      </Badge>
                      {u.memberships.length > 1 ? (
                        <span className="text-[13px] text-muted">+{u.memberships.length - 1} more</span>
                      ) : null}
                    </div>
                  )}
                </td>
                <td className="whitespace-nowrap px-5 py-3 text-[13px] text-muted">{formatRelative(u.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dialog
        ref={dialogRef}
        onClose={() => setSelected(null)}
        onClick={(e) => {
          if (e.target === dialogRef.current) close();
        }}
        className="m-auto w-[min(92vw,32rem)] rounded-lg border border-line bg-surface p-0 text-ink shadow-(--shadow-pop) backdrop:bg-ink/40"
      >
        {selected ? (
          <div className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-serif text-xl font-semibold text-ink">{selected.fullName ?? selected.email}</h2>
                {selected.fullName ? <p className="mt-0.5 text-sm text-muted">{selected.email}</p> : null}
              </div>
              {selected.isPlatformAdmin ? <Badge tone="accent">Platform admin</Badge> : null}
            </div>

            <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted">User ID</dt>
                <dd className="mt-1 break-all font-mono text-[12px] text-ink-2">{selected.id}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted">Joined</dt>
                <dd className="mt-1 text-ink-2">
                  {formatFullDate(selected.createdAt)}
                  <span className="ml-1.5 text-muted">({formatRelative(selected.createdAt)})</span>
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted">Email</dt>
                <dd className="mt-1 text-ink-2">{selected.email}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-muted">Platform role</dt>
                <dd className="mt-1 text-ink-2">{selected.isPlatformAdmin ? "Platform admin" : "Standard user"}</dd>
              </div>
            </dl>

            <div className="mt-5 border-t border-line pt-4">
              <h3 className="text-[13px] font-semibold text-ink">
                Workspaces ({selected.memberships.length})
              </h3>
              {selected.memberships.length === 0 ? (
                <p className="mt-2 text-sm text-muted">No workspace membership.</p>
              ) : (
                <ul className="mt-2 divide-y divide-line rounded-md border border-line">
                  {selected.memberships.map((m) => (
                    <li key={m.workspaceId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
                      <div className="min-w-0">
                        <Link
                          href={`/admin/workspaces/${m.workspaceId}`}
                          className="font-medium text-ink hover:text-accent"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {m.workspaceName}
                        </Link>
                        <p className="font-mono text-[12px] text-muted">/w/{m.workspaceSlug}</p>
                      </div>
                      <Badge tone={m.role === "owner" ? "accent" : "neutral"}>{m.role}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="mt-6 flex justify-end">
              <button type="button" className={buttonClasses("secondary")} onClick={close}>
                Close
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
