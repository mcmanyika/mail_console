import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { CreateListForm } from "@/components/campaigns/campaign-forms";
import { SectionDenied } from "@/components/settings/section-denied";
import { PageHeader, Panel } from "@/components/ui/panel";
import { SkeletonRows } from "@/components/ui/skeleton";
import { roleAtLeast } from "@/lib/auth/authz";
import { getWorkspaceContext } from "@/lib/data/workspace";

export const metadata: Metadata = { title: "New list" };

export default function NewListPage({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8 md:py-8">
      <PageHeader title="New audience list" description="Import contacts from CSV, then use the list in a campaign." />
      <Suspense fallback={<SkeletonRows rows={4} />}>
        <Body params={params} />
      </Suspense>
    </div>
  );
}

async function Body({ params }: { params: Promise<{ slug: string }> }) {
  await connection();
  const { slug } = await params;
  const ctx = await getWorkspaceContext(slug);
  if (!roleAtLeast(ctx.role, "admin")) return <SectionDenied slug={slug} section="Audience list" />;
  return (
    <Panel className="p-5">
      <CreateListForm slug={slug} />
    </Panel>
  );
}
