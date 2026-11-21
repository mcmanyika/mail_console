import Link from "next/link";
import { EmptyState } from "@/components/ui/empty-state";
import { LinkButton } from "@/components/ui/button";
import { Brand } from "@/components/layout/brand";
import { SearchX } from "lucide-react";

export default function WorkspaceNotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-5">
      <Brand className="mb-6" />
      <EmptyState
        icon={SearchX}
        title="Workspace not found"
        description="It may not exist, or you may not be a member. Platform admins manage workspaces from the admin console."
        action={<LinkButton href="/dashboard" variant="primary">Back to dashboard</LinkButton>}
      />
      <Link href="/" className="text-sm text-muted hover:text-ink">
        Home
      </Link>
    </div>
  );
}
