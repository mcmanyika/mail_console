import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { AdminShell } from "@/components/admin/admin-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { getCurrentProfile, requirePlatformAdminUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: { default: "Admin", template: "%s · Admin · Mail Console" } };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-[1280px] px-5 py-10">
          <Skeleton className="mb-6 h-9 w-64" />
          <Skeleton className="h-96 w-full" />
        </div>
      }
    >
      <AdminGate>{children}</AdminGate>
    </Suspense>
  );
}

/** Server-side gate: signed-out -> /login, non-platform-admins -> /dashboard. */
async function AdminGate({ children }: { children: React.ReactNode }) {
  // Auth + month-scoped stats use request time; wait for the incoming request
  // before continuing (Next 16 cacheComponents / Date.now during prerender).
  await connection();
  const user = await requirePlatformAdminUser();
  const profile = await getCurrentProfile();
  return (
    <AdminShell email={user.email ?? ""} name={profile?.full_name}>
      {children}
    </AdminShell>
  );
}
