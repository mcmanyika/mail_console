import type { Metadata } from "next";
import Link from "next/link";
import { CreateClientForm } from "@/components/admin/create-client-form";
import { PageHeader, Panel } from "@/components/ui/panel";

export const metadata: Metadata = { title: "Add client" };

export default function NewClientPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/admin" className="mb-4 inline-block text-[13px] text-muted hover:text-ink">
        ← Overview
      </Link>
      <PageHeader
        title="Add a client"
        description="Create the workspace, set its monthly limit and invite the owner. Domain setup comes next, from the workspace page."
      />
      <Panel className="p-6">
        <CreateClientForm />
      </Panel>
      <ol className="mt-6 space-y-2 text-[13px] text-muted">
        <li>
          <strong className="font-medium text-ink-2">1 · Create</strong> — workspace goes live immediately with the limit you set.
        </li>
        <li>
          <strong className="font-medium text-ink-2">2 · Invite</strong> — copy the owner link and send it yourself; it is single-use.
        </li>
        <li>
          <strong className="font-medium text-ink-2">3 · Domain</strong> — add a subdomain like mail.client.com and publish its DNS records.
        </li>
        <li>
          <strong className="font-medium text-ink-2">4 · Grants</strong> — the owner then grants themselves and teammates mailbox access explicitly.
        </li>
      </ol>
    </div>
  );
}
