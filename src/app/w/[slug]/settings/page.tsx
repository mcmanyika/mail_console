import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { getWorkspaceContext } from "@/lib/data/workspace";
import { accessibleSections } from "@/lib/settings-access";

export default function SettingsIndex({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <Suspense fallback={<Skeleton className="h-8 w-48" />}>
      <Go params={params} />
    </Suspense>
  );
}

async function Go({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await getWorkspaceContext(slug);
  const first = accessibleSections(ctx.role)[0];
  return redirect(`/w/${slug}/settings/${first?.key ?? "usage"}`);
}
