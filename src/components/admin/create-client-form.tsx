"use client";

import { useState } from "react";
import { createClientAction } from "@/lib/actions/admin";
import { ActionField, ActionForm } from "@/components/ui/action-form";
import { Input } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatPlanPrice, PLAN_LIST, type PlanId } from "@/lib/billing/plans";
import { slugify } from "@/lib/format";
import { cn } from "@/lib/utils";

export function CreateClientForm() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [plan, setPlan] = useState<PlanId>("growth");

  return (
    <ActionForm action={createClientAction}>
      <input type="hidden" name="plan" value={plan} />
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

      <fieldset className="space-y-3">
        <legend className="text-[13px] font-medium text-ink">Plan</legend>
        <p className="text-xs text-muted">Sets monthly send + AI limits. Billing is tracked outside the app for now.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {PLAN_LIST.map((p) => {
            const selected = plan === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setPlan(p.id)}
                className={cn(
                  "rounded-lg border p-3.5 text-left transition-colors",
                  selected ? "border-accent bg-accent-soft/50 ring-2 ring-accent/20" : "border-line bg-surface hover:border-line-strong",
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-ink">{p.name}</span>
                  <span className="text-[13px] tabular-nums text-ink-2">{formatPlanPrice(p)}</span>
                </div>
                {p.recommended ? <p className="mt-1 text-[11px] font-medium uppercase tracking-wide text-accent">Recommended</p> : null}
                <p className="mt-1.5 text-xs text-muted">{p.tagline}</p>
                <p className="mt-2 text-[12px] tabular-nums text-ink-2">
                  {p.monthlySendingLimit.toLocaleString()} sends · {p.monthlyAiLimit} AI
                </p>
              </button>
            );
          })}
        </div>
      </fieldset>

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
