import { ShieldAlert } from "lucide-react";
import { LinkButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/ui/panel";

export function SectionDenied({ slug, section }: { slug: string; section: string }) {
  return (
    <Panel>
      <EmptyState
        icon={ShieldAlert}
        title="You don't have access to this page"
        description={`${section} settings are limited to workspace owners and admins. Ask one of them if you need a change.`}
        action={
          <LinkButton href={`/w/${slug}/settings`} variant="secondary">
            Back to settings
          </LinkButton>
        }
      />
    </Panel>
  );
}
