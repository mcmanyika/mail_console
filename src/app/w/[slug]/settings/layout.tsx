import { Suspense } from "react";
import { SettingsNav } from "@/components/settings/settings-nav";
import { Skeleton } from "@/components/ui/skeleton";
import { getWorkspaceContext } from "@/lib/data/workspace";
import { accessibleSections } from "@/lib/settings-access";

export default function SettingsLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
      <div className="flex flex-col gap-6 md:flex-row md:gap-10">
        <aside className="shrink-0 md:w-48">
          <h2 className="mb-3 hidden px-3 font-serif text-lg font-semibold text-ink md:block">Settings</h2>
          <Suspense fallback={<Skeleton className="h-10 w-full md:h-48" />}>
            <Nav params={params} />
          </Suspense>
        </aside>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

async function Nav({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await getWorkspaceContext(slug);
  const items = accessibleSections(ctx.role).map((s) => ({ key: s.key, label: s.label }));
  return <SettingsNav slug={slug} items={items} />;
}
