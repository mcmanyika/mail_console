import { Inbox, Lock, MailX, SearchX } from "lucide-react";
import { LinkButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { roleAtLeast } from "@/lib/auth/authz";
import type { WorkspaceRole } from "@/lib/types/database";

export function NoMailboxAccess({ slug, role }: { slug: string; role: WorkspaceRole }) {
  const canManage = roleAtLeast(role, "admin");
  return (
    <EmptyState
      className="py-24"
      icon={Lock}
      title="You don't have access to any mailboxes yet"
      description={
        canManage ? (
          <>
            Mailbox access is granted per mailbox — owners and admins are not given mail access automatically. You can grant
            yourself access in Mailboxes settings (this is recorded in the audit log).
          </>
        ) : (
          <>Mailbox access is granted per mailbox. Ask a workspace owner or admin to give you read or read &amp; send access.</>
        )
      }
      action={
        canManage ? (
          <LinkButton href={`/w/${slug}/settings/mailboxes`} variant="primary">
            Manage mailbox access
          </LinkButton>
        ) : undefined
      }
    />
  );
}

export function MailboxDenied({ slug }: { slug: string }) {
  return (
    <EmptyState
      className="py-24"
      icon={Lock}
      title="You don't have access to that mailbox"
      description="Either it doesn't exist or no grant has been given to you. Pick one of the mailboxes you can read."
      action={
        <LinkButton href={`/w/${slug}/inbox`} variant="secondary">
          Back to my inbox
        </LinkButton>
      }
    />
  );
}

export function EmptyFolder({ folder, searching }: { folder: string; searching: boolean }) {
  if (searching) {
    return <EmptyState icon={SearchX} title="No results" description="Nothing in this folder matches your search." />;
  }
  const copy: Record<string, { title: string; description: string }> = {
    inbox: { title: "Inbox zero", description: "New conversations will show up here as soon as they arrive." },
    sent: { title: "Nothing sent yet", description: "Messages you and your teammates send from these mailboxes appear here." },
    drafts: { title: "No drafts", description: "Drafts you save are private to you." },
    archive: { title: "Nothing archived", description: "Archived conversations stay out of your inbox but remain searchable." },
  };
  const c = copy[folder] ?? copy.inbox;
  return <EmptyState icon={folder === "inbox" ? Inbox : MailX} title={c.title} description={c.description} />;
}

export function NoSelection() {
  return (
    <div className="hidden flex-1 items-center justify-center lg:flex">
      <EmptyState icon={Inbox} title="Select a conversation" description="Choose something from the list to read it here." />
    </div>
  );
}
