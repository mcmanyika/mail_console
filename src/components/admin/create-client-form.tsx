"use client";

import { useState } from "react";
import { createClientAction } from "@/lib/actions/admin";
import { ActionField, ActionForm } from "@/components/ui/action-form";
import { Input } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";
import { slugify } from "@/lib/format";

export function CreateClientForm() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);

  return (
    <ActionForm action={createClientAction}>
      <ActionField label="Client name" name="name">
        <Input
          id="name"
          name="name"
          required
          maxLength={120}
          placeholder="Overflow Connections"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(slugify(e.target.value));
          }}
        />
      </ActionField>
      <ActionField label="Workspace URL" name="slug" hint="Used in the address: /w/<slug>/inbox">
        <div className="flex items-center">
          <span className="flex h-9 items-center rounded-l-md border border-r-0 border-line-strong bg-surface-muted px-3 font-mono text-xs text-muted">
            /w/
          </span>
          <Input
            id="slug"
            name="slug"
            className="rounded-l-none font-mono"
            placeholder="overflow-connections"
            value={slug}
            onChange={(e) => {
              setSlug(slugify(e.target.value));
              setSlugTouched(true);
            }}
          />
        </div>
      </ActionField>
      <ActionField label="Monthly sending limit" name="limit" hint="Unique recipients per calendar month (UTC). Counts To + Cc + Bcc.">
        <Input id="limit" name="limit" type="number" min={0} step={1} defaultValue={3000} required className="max-w-40 tabular-nums" />
      </ActionField>
      <ActionField label="Owner email" name="ownerEmail" hint="They'll get an invitation link. The first person to accept becomes the workspace owner.">
        <Input id="ownerEmail" name="ownerEmail" type="email" required placeholder="owner@client.com" />
      </ActionField>
      <div className="pt-2">
        <SubmitButton size="lg" pendingLabel="Creating workspace…">
          Create workspace &amp; invite owner
        </SubmitButton>
      </div>
    </ActionForm>
  );
}
