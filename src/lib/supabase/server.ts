import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabasePublicConfig } from "@/lib/env";
import type { Database } from "@/lib/types/database";

/**
 * Request-scoped Supabase client bound to the signed-in user's session cookies
 * (anon key, subject to RLS). Use in Server Components, Server Actions and
 * Route Handlers.
 *
 * Next 16: `cookies()` is async and is a dynamic API. With `cacheComponents`
 * enabled, call this only from components rendered inside <Suspense> (or from
 * actions/route handlers), never from cached (`"use cache"`) scopes.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const { url, anonKey } = getSupabasePublicConfig();

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // Safe to ignore: src/proxy.ts refreshes the session on every request.
        }
      },
    },
  });
}
