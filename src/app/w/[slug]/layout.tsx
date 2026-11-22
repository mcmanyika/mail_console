import { connection } from "next/server";
import { Suspense } from "react";
import { ShellSkeleton, WorkspaceShell } from "@/components/layout/workspace-shell";

export default function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <ShellFromParams params={params}>{children}</ShellFromParams>
    </Suspense>
  );
}

async function ShellFromParams({ params, children }: { params: Promise<{ slug: string }>; children: React.ReactNode }) {
  // Workspace UI uses relative times (Date.now); opt the tree out of prerender.
  await connection();
  const { slug } = await params;
  return <WorkspaceShell slug={slug}>{children}</WorkspaceShell>;
}
