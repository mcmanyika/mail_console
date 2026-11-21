import { unstable_rethrow } from "next/navigation";
import { AuthzError } from "@/lib/auth/authz";
import { fail, type ActionState } from "./state";

/**
 * Wraps a server action body: authz failures become form errors, framework
 * control-flow (redirect/notFound) is re-thrown, anything else is logged and
 * surfaced as a generic message (never leak internals to the client).
 */
export async function guarded(fn: () => Promise<ActionState>): Promise<ActionState> {
  try {
    return await fn();
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof AuthzError) return fail(error.message);
    console.error("[action]", error);
    return fail("Something went wrong. Please try again.");
  }
}

export function formString(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}
