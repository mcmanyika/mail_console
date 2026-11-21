import { SearchX } from "lucide-react";
import { Brand } from "@/components/layout/brand";
import { LinkButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-5">
      <Brand className="mb-6" />
      <EmptyState
        icon={SearchX}
        title="Page not found"
        description="The page you're looking for doesn't exist or has moved."
        action={<LinkButton href="/dashboard" variant="primary">Go to dashboard</LinkButton>}
      />
    </div>
  );
}
