import { redirect } from "next/navigation";
import { Suspense } from "react";

export default function WorkspaceIndex({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <Suspense fallback={null}>
      <Go params={params} />
    </Suspense>
  );
}

async function Go({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return redirect(`/w/${slug}/inbox`);
}
