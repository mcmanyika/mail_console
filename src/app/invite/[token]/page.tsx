import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { AcceptInviteForm } from "@/components/auth/accept-invite";
import { AuthShell } from "@/components/layout/auth-shell";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Skeleton } from "@/components/ui/skeleton";
import { signOutAction } from "@/lib/actions/auth";
import { getCurrentUser } from "@/lib/auth/session";
import { lookupInvite } from "@/lib/data/invites";

export const metadata: Metadata = { title: "Workspace invitation" };

export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <Suspense
      fallback={
        <AuthShell title="Checking invitation…">
          <Skeleton className="h-32 w-full" />
        </AuthShell>
      }
    >
      <InviteBody params={params} />
    </Suspense>
  );
}

async function InviteBody({ params }: { params: Promise<{ token: string }> }) {
  // Expiry check uses Date.now(); wait for the request (Next 16 cacheComponents).
  await connection();
  const { token } = await params;
  const [invite, user] = await Promise.all([lookupInvite(token), getCurrentUser()]);

  if (invite.state === "invalid") {
    return (
      <AuthShell title="Invitation not found" subtitle="This link isn't valid. Check that you copied the whole URL.">
        <LinkButton href="/login" variant="secondary" className="w-full">
          Go to sign in
        </LinkButton>
      </AuthShell>
    );
  }

  const next = `/invite/${token}`;
  const q = new URLSearchParams({ next, email: invite.invitation.email }).toString();
  const unusable = invite.state !== "valid";
  const emailMatches = user?.email?.toLowerCase() === invite.invitation.email;

  return (
    <AuthShell
      title={`Join ${invite.workspaceName}`}
      subtitle="You've been invited to a shared workspace on Mail Console."
    >
      <div className="rounded-lg border border-line bg-surface p-4">
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Invited email</dt>
            <dd className="font-medium text-ink">{invite.invitation.email}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Role</dt>
            <dd>
              <Badge tone="accent">{invite.invitation.role}</Badge>
            </dd>
          </div>
        </dl>
      </div>
      <p className="mt-3 text-xs text-muted">
        Joining gives you workspace access. Reading or sending mail from a mailbox still needs an explicit grant from a
        workspace owner or admin.
      </p>

      <div className="mt-6 space-y-3">
        {unusable ? (
          <Alert tone="warn" title={invite.state === "accepted" ? "Already used" : invite.state === "revoked" ? "Revoked" : "Expired"}>
            Ask a workspace admin to send a new invitation.
          </Alert>
        ) : !user ? (
          <>
            <LinkButton href={`/signup?${q}`} variant="primary" size="lg" className="w-full">
              Create account to join
            </LinkButton>
            <LinkButton href={`/login?${q}`} variant="secondary" size="lg" className="w-full">
              I already have an account
            </LinkButton>
          </>
        ) : emailMatches ? (
          <AcceptInviteForm token={token} workspaceName={invite.workspaceName} />
        ) : (
          <>
            <Alert tone="warn" title="Wrong account">
              You&apos;re signed in as {user.email}, but this invitation was sent to {invite.invitation.email}.
            </Alert>
            <form action={signOutAction}>
              <SubmitButton variant="secondary" size="lg" className="w-full">
                Sign out and switch account
              </SubmitButton>
            </form>
          </>
        )}
      </div>
    </AuthShell>
  );
}
