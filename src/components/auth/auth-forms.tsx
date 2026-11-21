"use client";

import { loginAction, signupAction } from "@/lib/actions/auth";
import { ActionField, ActionForm } from "@/components/ui/action-form";
import { Input } from "@/components/ui/form-controls";
import { SubmitButton } from "@/components/ui/submit-button";

export function LoginForm({ next, email }: { next?: string; email?: string }) {
  return (
    <ActionForm action={loginAction}>
      <input type="hidden" name="next" value={next ?? ""} />
      <ActionField label="Email" name="email">
        <Input id="email" name="email" type="email" autoComplete="email" required defaultValue={email} placeholder="you@company.com" />
      </ActionField>
      <ActionField label="Password" name="password">
        <Input id="password" name="password" type="password" autoComplete="current-password" required minLength={8} />
      </ActionField>
      <SubmitButton size="lg" className="w-full" pendingLabel="Signing in…">
        Sign in
      </SubmitButton>
    </ActionForm>
  );
}

export function SignupForm({ next, email }: { next?: string; email?: string }) {
  return (
    <ActionForm action={signupAction}>
      <input type="hidden" name="next" value={next ?? ""} />
      <ActionField label="Full name" name="fullName">
        <Input id="fullName" name="fullName" autoComplete="name" required placeholder="Maya Okafor" />
      </ActionField>
      <ActionField label="Work email" name="email">
        <Input id="email" name="email" type="email" autoComplete="email" required defaultValue={email} placeholder="you@company.com" />
      </ActionField>
      <ActionField label="Password" name="password" hint="At least 8 characters.">
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} />
      </ActionField>
      <SubmitButton size="lg" className="w-full" pendingLabel="Creating account…">
        Create account
      </SubmitButton>
    </ActionForm>
  );
}
