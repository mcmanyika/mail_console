import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { LoginForm } from "@/components/auth/auth-forms";
import { AuthShell } from "@/components/layout/auth-shell";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { first } from "@/lib/format";
import { safeNextPath } from "@/lib/routes";

export const metadata: Metadata = { title: "Sign in" };

type SP = Promise<Record<string, string | string[] | undefined>>;

/** Landing page — sign in. */
export default function Home({ searchParams }: { searchParams: SP }) {
  return (
    <AuthShell
      title="Sign in"
      subtitle="Welcome back."
      footer={
        <Suspense fallback={null}>
          <SignupLink searchParams={searchParams} />
        </Suspense>
      }
    >
      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        <LoginBody searchParams={searchParams} />
      </Suspense>
    </AuthShell>
  );
}

async function LoginBody({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const next = safeNextPath(first(sp.next), "");
  return (
    <div className="space-y-4">
      {first(sp.error) === "confirm" ? (
        <Alert tone="warn">That confirmation link has expired. Sign in, or create the account again.</Alert>
      ) : null}
      {first(sp.error) === "auth" ? (
        <Alert tone="danger" title="Sign-in link expired">
          Request a new one or sign in with your password.
        </Alert>
      ) : null}
      <LoginForm next={next || undefined} email={first(sp.email)} />
    </div>
  );
}

async function SignupLink({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const next = safeNextPath(first(sp.next), "");
  const qs = new URLSearchParams();
  if (next) qs.set("next", next);
  if (first(sp.email)) qs.set("email", first(sp.email) as string);
  const suffix = qs.size ? `?${qs}` : "";
  return (
    <div className="space-y-2">
      <p>
        New to Mail Console?{" "}
        <Link href={`/signup${suffix}`} className="font-medium text-accent hover:underline">
          Create an account
        </Link>
      </p>
      <p>
        <Link href="/packages" className="font-medium text-accent hover:underline">
          View packages
        </Link>
        <span className="text-muted"> — Starter, Growth &amp; Scale</span>
      </p>
    </div>
  );
}
