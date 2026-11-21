"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { safeNextPath } from "@/lib/routes";
import { getAppUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { guarded, formString } from "./guard";
import { fail, ok, type ActionState } from "./state";

const credentials = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: z.string().min(8, "Use at least 8 characters").max(200),
});

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    out[key] ??= issue.message;
  }
  return out;
}

export async function loginAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const next = safeNextPath(formString(formData, "next"));
  const result = await guarded(async () => {
    const parsed = credentials.safeParse({ email: formData.get("email"), password: formData.get("password") });
    if (!parsed.success) return fail("Check the highlighted fields.", fieldErrors(parsed.error));
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithPassword(parsed.data);
    if (error) {
      // Generic on purpose: do not reveal whether the account exists.
      return fail("That email and password don't match. Try again or create an account.");
    }
    return ok();
  });
  if (result.status === "success") redirect(next);
  return result;
}

export async function signupAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const next = safeNextPath(formString(formData, "next"));
  const result = await guarded(async () => {
    const parsed = credentials
      .extend({ fullName: z.string().trim().min(1, "Tell us your name").max(120) })
      .safeParse({
        email: formData.get("email"),
        password: formData.get("password"),
        fullName: formData.get("fullName"),
      });
    if (!parsed.success) return fail("Check the highlighted fields.", fieldErrors(parsed.error));

    const supabase = await createClient();
    const h = await headers();
    const origin = h.get("origin") ?? getAppUrl();
    const { data, error } = await supabase.auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      options: {
        data: { full_name: parsed.data.fullName },
        emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    if (error) return fail(error.message || "We couldn't create that account.");
    if (!data.session) {
      return ok("Check your inbox to confirm your email address, then sign in to continue.");
    }
    return ok();
  });
  if (result.status === "success" && !result.message) redirect(next);
  return result;
}

export async function signOutAction(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
