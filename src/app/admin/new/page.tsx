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
      <PageHeader title="Add a client" />
      <Panel className="p-6">
        <CreateClientForm />
      </Panel>
    </div>
  );
}
