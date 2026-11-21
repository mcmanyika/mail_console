import type { Metadata } from "next";
import { FileText } from "lucide-react";
import { Suspense } from "react";
import { EditableTemplate, TemplateForm } from "@/components/settings/template-forms";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmButton } from "@/components/ui/confirm-dialog";
import { PageHeader, Panel, PanelHeader } from "@/components/ui/panel";
import { SkeletonRows } from "@/components/ui/skeleton";
import { deleteTemplateAction } from "@/lib/actions/settings";
import { roleAtLeast } from "@/lib/auth/authz";
import { gateSection, getTemplates } from "@/lib/data/settings";

export const metadata: Metadata = { title: "Templates" };

export default function TemplatesPage({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <>
      <PageHeader title="Templates" description="Reusable subjects and bodies. Insert one from the compose screen." />
      <Suspense fallback={<SkeletonRows rows={4} />}>
        <Body params={params} />
      </Suspense>
    </>
  );
}

async function Body({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { ctx } = await gateSection(slug, "templates");
  const canEdit = roleAtLeast(ctx.role, "admin");
  const templates = await getTemplates(ctx);

  return (
    <div className="space-y-6">
      {canEdit ? (
        <Panel className="p-5">
          <h2 className="mb-4 text-[15px] font-semibold text-ink">New template</h2>
          <div className="max-w-2xl">
            <TemplateForm slug={slug} />
          </div>
        </Panel>
      ) : (
        <p className="rounded-md border border-line bg-surface px-4 py-3 text-[13px] text-muted">
          You can use templates when composing. Owners and admins can create and edit them.
        </p>
      )}

      <Panel>
        <PanelHeader title="Your templates" description={`${templates.length} saved`} />
        {templates.length === 0 ? (
          <EmptyState icon={FileText} title="No templates yet" description="Create one above to reuse common replies." />
        ) : (
          <ul className="divide-y divide-line">
            {templates.map((t) => {
              const summary = (
                <>
                  <p className="text-sm font-medium text-ink">{t.name}</p>
                  <p className="mt-0.5 truncate text-[13px] text-ink-2">{t.subject || "(no subject)"}</p>
                  <p className="mt-1 line-clamp-2 whitespace-pre-line text-[13px] text-muted">{t.body_text}</p>
                  {Array.isArray(t.variables) && t.variables.length ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {(t.variables as string[]).map((v) => (
                        <Badge key={v}>{`{{${v}}}`}</Badge>
                      ))}
                    </div>
                  ) : null}
                </>
              );
              return (
                <li key={t.id}>
                  {canEdit ? (
                    <EditableTemplate slug={slug} template={{ id: t.id, name: t.name, subject: t.subject, body: t.body_text ?? "" }}>
                      {summary}
                      <div className="mt-3">
                        <ConfirmButton
                          action={deleteTemplateAction.bind(null, slug, t.id)}
                          triggerLabel="Delete"
                          triggerSize="sm"
                          title={`Delete “${t.name}”?`}
                          confirmLabel="Delete template"
                          description="This can't be undone. Messages already sent from it are unaffected."
                        />
                      </div>
                    </EditableTemplate>
                  ) : (
                    <div className="px-5 py-4">{summary}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
