import { unstable_rethrow } from "next/navigation";
import { AuthzError } from "@/lib/auth/authz";
import { MissingEnvError } from "@/lib/env";
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
    if (error instanceof MissingEnvError) {
      console.error("[action]", error.message);
      return fail("Server is missing a required secret. Set API_KEY_PEPPER (and other env vars) in Vercel, then redeploy.");
    }
    // Invite token hashing throws a plain Error when the pepper is missing in production.
    if (error instanceof Error && /API_KEY_PEPPER/.test(error.message)) {
      console.error("[action]", error.message);
      return fail("Set API_KEY_PEPPER in your environment (≥ 16 characters), then try again.");
    }
    console.error("[action]", error);
    return fail("Something went wrong. Please try again.");
  }
}

export function formString(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}
