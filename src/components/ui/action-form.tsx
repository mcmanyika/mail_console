"use client";

import Link from "next/link";
import { createContext, useActionState, useContext, useEffect, useRef } from "react";
import { idleState, type ActionState } from "@/lib/actions/state";
import { cn } from "@/lib/utils";
import { Alert } from "./alert";
import { CopyButton } from "./copy-button";

const FieldErrorsContext = createContext<Record<string, string>>({});

/**
 * <form> wired to a `(prev, formData) => ActionState` server action.
 * Renders the success/error message, field errors are read by children via
 * `FieldError`, and one-time reveals (API keys / invite links) are shown once.
 */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess,
  hideSuccessMessage,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  children: React.ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  hideSuccessMessage?: boolean;
}) {
  const [state, formAction] = useActionState(action, idleState);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === "success" && resetOnSuccess) formRef.current?.reset();
  }, [state, resetOnSuccess]);

  return (
    <form ref={formRef} action={formAction} className={cn("space-y-4", className)}>
      {state.status === "error" && state.message ? <Alert tone="danger">{state.message}</Alert> : null}
      {state.status === "success" && state.message && !hideSuccessMessage ? (
        <Alert tone="success">{state.message}</Alert>
      ) : null}
      {state.reveal ? (
        <div className="rounded-md border border-warn/30 bg-warn-soft p-3.5">
          <p className="text-[13px] font-semibold text-warn">{state.reveal.label}</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded border border-line bg-surface px-2.5 py-1.5 font-mono text-xs text-ink">
              {state.reveal.value}
            </code>
            <CopyButton value={state.reveal.value} />
          </div>
          {state.reveal.note ? <p className="mt-2 text-xs text-warn">{state.reveal.note}</p> : null}
        </div>
      ) : null}
      {state.links?.length ? (
        <div className="flex flex-wrap gap-3 text-sm">
          {state.links.map((l) => (
            <Link key={l.href} href={l.href} className="font-medium text-accent underline-offset-2 hover:underline">
              {l.label} →
            </Link>
          ))}
        </div>
      ) : null}
      <FieldErrorsContext.Provider value={state.fieldErrors ?? {}}>{children}</FieldErrorsContext.Provider>
    </form>
  );
}

/** Reads the error for a named field from the nearest <ActionForm>. */
export function useFieldError(name: string): string | undefined {
  return useContext(FieldErrorsContext)[name];
}

/** Label + control + hint + server-side field error, resolved by `name`. */
export function ActionField({
  label,
  name,
  hint,
  children,
  className,
}: {
  label: string;
  name: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const error = useFieldError(name);
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={name} className="block text-[13px] font-medium text-ink">
        {label}
      </label>
      {children}
      {hint && !error ? <p className="text-xs text-muted">{hint}</p> : null}
      {error ? (
        <p role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
