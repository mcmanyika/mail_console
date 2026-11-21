import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { SignupForm } from "@/components/auth/auth-forms";
import { AuthShell } from "@/components/layout/auth-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { first } from "@/lib/format";
import { safeNextPath } from "@/lib/routes";

export const metadata: Metadata = { title: "Create account" };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default function SignupPage({ searchParams }: { searchParams: SP }) {
  return (
    <AuthShell
      title="Create your account"
      subtitle="Accounts join client workspaces by invitation — create yours first, then accept the invite."
      footer={
        <Suspense fallback={null}>
          <LoginLink searchParams={searchParams} />
        </Suspense>
      }
    >
      <Suspense fallback={<Skeleton className="h-72 w-full" />}>
        <SignupBody searchParams={searchParams} />
      </Suspense>
    </AuthShell>
  );
}

async function SignupBody({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const next = safeNextPath(first(sp.next), "");
  return <SignupForm next={next || undefined} email={first(sp.email)} />;
}

async function LoginLink({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const next = safeNextPath(first(sp.next), "");
  const qs = new URLSearchParams();
  if (next) qs.set("next", next);
  if (first(sp.email)) qs.set("email", first(sp.email) as string);
  const suffix = qs.size ? `?${qs}` : "";
  return (
    <>
      Already have an account?{" "}
      <Link href={`/login${suffix}`} className="font-medium text-accent hover:underline">
        Sign in
      </Link>
    </>
  );
}
