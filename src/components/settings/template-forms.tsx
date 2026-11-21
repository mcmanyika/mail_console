"use client";

import { useState } from "react";
import { saveTemplateAction } from "@/lib/actions/settings";
import { ActionField, ActionForm } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";

export function TemplateForm({
  slug,
  template,
  onDone,
}: {
  slug: string;
  template?: { id: string; name: string; subject: string; body: string };
  onDone?: () => void;
}) {
  return (
    <ActionForm action={saveTemplateAction} resetOnSuccess={!template}>
      <input type="hidden" name="slug" value={slug} />
      {template ? <input type="hidden" name="templateId" value={template.id} /> : null}
      <ActionField label="Template name" name="name">
        <Input id={`name-${template?.id ?? "new"}`} name="name" defaultValue={template?.name} required maxLength={120} placeholder="Welcome" />
      </ActionField>
      <ActionField label="Subject" name="subject" hint="Use {{first_name}}-style placeholders; they're detected automatically.">
        <Input id={`subject-${template?.id ?? "new"}`} name="subject" defaultValue={template?.subject} maxLength={300} placeholder="Welcome to Acme, {{first_name}}!" />
      </ActionField>
      <ActionField label="Body" name="body">
        <Textarea id={`body-${template?.id ?? "new"}`} name="body" defaultValue={template?.body} rows={8} placeholder={"Hi {{first_name}},\n\n…"} />
      </ActionField>
      <div className="flex gap-2">
        <SubmitButton pendingLabel="Saving…">{template ? "Save changes" : "Create template"}</SubmitButton>
        {onDone ? (
          <Button variant="ghost" onClick={onDone}>
            Close
          </Button>
        ) : null}
      </div>
    </ActionForm>
  );
}

export function EditableTemplate({
  slug,
  template,
  children,
}: {
  slug: string;
  template: { id: string; name: string; subject: string; body: string };
  /** Server-rendered summary + delete control. */
  children: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  return editing ? (
    <div className="p-5">
      <TemplateForm slug={slug} template={template} onDone={() => setEditing(false)} />
    </div>
  ) : (
    <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
      <div className="min-w-0 flex-1">{children}</div>
      <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
        Edit
      </Button>
    </div>
  );
}
