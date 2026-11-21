/** Shared shape returned by server actions used with `useActionState`. */
export type ActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
  /** One-time values (API keys, invite links). Rendered once by <ActionForm>. */
  reveal?: { label: string; value: string; note?: string };
  links?: { href: string; label: string }[];
  /** Arbitrary small payload for specific forms (never message content). */
  data?: Record<string, string | number | boolean | null | Array<Record<string, string | number | null>>>;
};

export const idleState: ActionState = { status: "idle" };

export function ok(message?: string, extra: Partial<ActionState> = {}): ActionState {
  return { status: "success", message, ...extra };
}

export function fail(message: string, fieldErrors?: Record<string, string>): ActionState {
  return { status: "error", message, fieldErrors };
}
