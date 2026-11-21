import { ZodError } from "zod";
import { AuthzError } from "@/lib/auth/authz";
import { getCurrentUser } from "@/lib/auth/session";
import { ComposeError } from "@/lib/email/compose";
import { DomainServiceError } from "@/lib/resend/domains";
import { AdminServiceError } from "@/lib/services/admin";
import { InboxError } from "@/lib/services/inbox";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";

/**
 * Uniform return type for server actions. Actions never throw domain errors
 * across the RPC boundary; they return `{ ok: false, code, error }` so client
 * components can render them. Unexpected errors are logged server-side and
 * surfaced as a generic message.
 */
export type ActionResult<T extends object = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; code: string; error: string };

export function toFailure(err: unknown): { ok: false; code: string; error: string } {
  if (err instanceof AuthzError) {
    return { ok: false, code: err.status === 401 ? "unauthorized" : err.status === 404 ? "not_found" : "forbidden", error: err.message };
  }
  if (err instanceof ZodError) {
    return { ok: false, code: "validation_error", error: err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") };
  }
  if (err instanceof ComposeError || err instanceof DomainServiceError || err instanceof InboxError || err instanceof AdminServiceError) {
    return { ok: false, code: err.code, error: err.message };
  }
  console.error("[server action] unexpected error", err instanceof Error ? err.message : err);
  return { ok: false, code: "internal_error", error: "Something went wrong. Please try again." };
}

/** Authenticates the caller (Supabase session cookie) and runs `fn` with the verified user id + service client. */
export async function runAuthed<T extends object>(
  fn: (ctx: { admin: AdminClient; userId: string }) => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    const user = await getCurrentUser();
    if (!user) return { ok: false, code: "unauthorized", error: "Please sign in" };
    const value = await fn({ admin: createAdminClient(), userId: user.id });
    return { ok: true, ...value };
  } catch (err) {
    return toFailure(err);
  }
}
