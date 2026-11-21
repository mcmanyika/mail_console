"use client";

import { useRef, useState } from "react";
import { buttonClasses, type ButtonVariant } from "./button";
import { SubmitButton } from "./submit-button";

/**
 * A button that opens a native <dialog> asking for confirmation before running
 * a server action. `action` is a server action (or bound form action).
 */
export function ConfirmButton({
  action,
  triggerLabel,
  triggerVariant = "danger-ghost",
  triggerSize = "md",
  title,
  description,
  confirmLabel,
  confirmVariant = "danger",
  children,
  hiddenFields,
}: {
  action: (formData: FormData) => void | Promise<void>;
  triggerLabel: React.ReactNode;
  triggerVariant?: ButtonVariant;
  triggerSize?: "sm" | "md";
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  confirmVariant?: ButtonVariant;
  children?: React.ReactNode;
  hiddenFields?: Record<string, string>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={buttonClasses(triggerVariant, triggerSize)}
        onClick={() => {
          ref.current?.showModal();
          setOpen(true);
        }}
      >
        {triggerLabel}
      </button>
      <dialog
        ref={ref}
        onClose={() => setOpen(false)}
        className="m-auto w-[min(92vw,28rem)] rounded-lg border border-line bg-surface p-0 text-ink-2 shadow-(--shadow-pop)"
      >
        {open ? (
          <form action={action} className="p-5">
            {Object.entries(hiddenFields ?? {}).map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
            <h2 className="font-serif text-xl font-semibold text-ink">{title}</h2>
            <div className="mt-2 text-sm leading-relaxed text-muted">{description}</div>
            {children ? <div className="mt-4">{children}</div> : null}
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" className={buttonClasses("secondary")} onClick={() => ref.current?.close()}>
                Cancel
              </button>
              <SubmitButton variant={confirmVariant} pendingLabel="Working…">
                {confirmLabel}
              </SubmitButton>
            </div>
          </form>
        ) : null}
      </dialog>
    </>
  );
}
