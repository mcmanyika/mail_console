"use client";

import { createAudienceListAction, createCampaignAction, importContactsAction } from "@/lib/actions/campaigns";
import { ActionField, ActionForm } from "@/components/ui/action-form";
import { Input, Select, Textarea } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";

export function CreateListForm({ slug }: { slug: string }) {
  return (
    <ActionForm action={createAudienceListAction}>
      <input type="hidden" name="slug" value={slug} />
      <ActionField label="List name" name="name">
        <Input id="name" name="name" required maxLength={120} placeholder="Customers — March" />
      </ActionField>
      <ActionField label="Description" name="description" hint="Optional">
        <Input id="description" name="description" maxLength={500} placeholder="Imported from CRM export" />
      </ActionField>
      <SubmitButton pendingLabel="Creating…">Create list</SubmitButton>
    </ActionForm>
  );
}

export function ImportContactsForm({
  slug,
  listId,
  contactLimit,
  planName,
}: {
  slug: string;
  listId: string;
  contactLimit: number;
  planName: string;
}) {
  return (
    <ActionForm action={importContactsAction}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="listId" value={listId} />
      <ActionField
        label="CSV file"
        name="csv"
        hint={`Header row required. Must include email. ${planName} package: max ${contactLimit.toLocaleString()} contacts per list.`}
      >
        <Input id="csv" name="csv" type="file" accept=".csv,text/csv,text/plain" />
      </ActionField>
      <ActionField label="Or paste CSV" name="csvText">
        <Textarea id="csvText" name="csvText" rows={6} placeholder={"email,name\nperson@example.com,Alex"} className="font-mono text-[13px]" />
      </ActionField>
      <SubmitButton pendingLabel="Importing…">Import contacts</SubmitButton>
    </ActionForm>
  );
}

export function CreateCampaignForm({
  slug,
  lists,
  mailboxes,
  templates,
  contactLimit,
  planName,
  sendsRemaining,
  monthlySendLimit,
}: {
  slug: string;
  lists: { id: string; name: string; contactCount: number }[];
  mailboxes: { id: string; label: string }[];
  templates: { id: string; name: string; subject: string; body: string }[];
  contactLimit: number;
  planName: string;
  sendsRemaining: number;
  monthlySendLimit: number;
}) {
  return (
    <ActionForm action={createCampaignAction} className="space-y-4">
      <input type="hidden" name="slug" value={slug} />
      <p className="rounded-md border border-line bg-canvas-deep/50 px-3 py-2 text-[13px] text-muted">
        {planName} package: lists up to {contactLimit.toLocaleString()} contacts · {sendsRemaining.toLocaleString()} of{" "}
        {monthlySendLimit.toLocaleString()} monthly sends left. Campaigns larger than either limit are blocked.
      </p>
      <ActionField label="Campaign name" name="name">
        <Input id="name" name="name" required maxLength={120} placeholder="March newsletter" />
      </ActionField>
      <ActionField label="Audience list" name="listId">
        <Select id="listId" name="listId" required defaultValue="">
          <option value="" disabled>
            Choose a list…
          </option>
          {lists.map((l) => {
            const overPlan = l.contactCount > contactLimit;
            const overQuota = l.contactCount > sendsRemaining;
            const suffix = overPlan ? " — over package" : overQuota ? " — over monthly quota" : "";
            return (
              <option key={l.id} value={l.id} disabled={overPlan || overQuota || l.contactCount < 1}>
                {l.name} ({l.contactCount}){suffix}
              </option>
            );
          })}
        </Select>
      </ActionField>
      <ActionField label="From mailbox" name="mailboxId">
        <Select id="mailboxId" name="mailboxId" required defaultValue="">
          <option value="" disabled>
            Choose a mailbox…
          </option>
          {mailboxes.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>
      </ActionField>
      {templates.length ? (
        <p className="text-[13px] text-muted">
          Tip: copy subject/body from a template, then personalize with {"{{first_name}}"}, {"{{email}}"}, or CSV columns.
        </p>
      ) : null}
      <ActionField label="Subject" name="subject" hint="Supports {{variable}} placeholders from the list.">
        <Input id="subject" name="subject" required maxLength={300} placeholder="Hello {{first_name}}" />
      </ActionField>
      <ActionField label="Message" name="body">
        <Textarea
          id="body"
          name="body"
          required
          rows={10}
          placeholder={"Hi {{first_name}},\n\n…"}
          className="min-h-48 font-sans text-[14px] leading-relaxed"
        />
      </ActionField>
      <ActionField label="Schedule (optional)" name="scheduleAt" hint="Leave blank to save as draft and start manually. Uses your local timezone in the picker.">
        <Input id="scheduleAt" name="scheduleAt" type="datetime-local" />
      </ActionField>
      <SubmitButton pendingLabel="Saving…">Save campaign</SubmitButton>
    </ActionForm>
  );
}
