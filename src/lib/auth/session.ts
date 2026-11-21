import type { User } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { cache } from "react";
import { LOGIN_PATH } from "@/lib/routes";
import { createClient } from "@/lib/supabase/server";
import type { ProfileRow } from "@/lib/types/database";
import { isPlatformAdmin } from "./authz";

/**
 * Server-side session helpers (Server Components, Server Actions, Route Handlers).
 * All memoised per request with React `cache`.
 *
 * `getUser()` round-trips to Supabase Auth and is the authoritative check —
 * never trust `getSession()` or cookie contents on the server.
 *
 * Next 16 + `cacheComponents`: these read cookies, so call them from inside a
 * <Suspense> boundary (or an action/route handler), not from cached scopes.
 */

export const getCurrentUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
});

/** Redirects to /login (preserving `next`) when signed out. */
export async function requireUser(nextPath?: string): Promise<User> {
  const user = await getCurrentUser();
  if (!user) {
    const qs = nextPath ? `?next=${encodeURIComponent(nextPath)}` : "";
    redirect(`${LOGIN_PATH}${qs}`);
  }
  return user;
}

export const getCurrentProfile = cache(async (): Promise<ProfileRow | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  const supabase = await createClient();
  const { data } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
  return data;
});

export const getIsPlatformAdmin = cache(async (): Promise<boolean> => {
  const user = await getCurrentUser();
  if (!user) return false;
  const supabase = await createClient();
  return isPlatformAdmin(supabase, user.id);
});

/** For /admin routes: signed-in platform admins only; everyone else is sent away. */
export async function requirePlatformAdminUser(): Promise<User> {
  const user = await requireUser("/admin");
  const supabase = await createClient();
  if (!(await isPlatformAdmin(supabase, user.id))) redirect("/dashboard");
  return user;
}

/** The signed-in user's workspaces with their role (RLS-scoped). */
export const getUserWorkspaces = cache(async () => {
  const user = await getCurrentUser();
  if (!user) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspace_memberships")
    .select("role, workspace:workspaces(id, name, slug, status)")
    .eq("user_id", user.id);
  if (error) throw new Error(`failed to load workspaces: ${error.message}`);
  return data ?? [];
});
