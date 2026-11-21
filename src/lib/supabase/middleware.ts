import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabasePublicConfig } from "@/lib/env";
import type { Database } from "@/lib/types/database";

export type SessionUpdate = {
  /** The response to return (carries refreshed auth cookies). */
  response: NextResponse;
  /** Verified user id (JWT claims `sub`), or null when signed out. */
  userId: string | null;
};

/**
 * Refreshes the Supabase auth session for a request and returns the response
 * carrying any rotated cookies. Called from `src/proxy.ts` (Next 16's rename of
 * `middleware.ts`) — the file name here is kept for the conventional layout.
 *
 * Uses `getClaims()` which verifies the JWT signature (never trust
 * `getSession()` on the server), refreshing expired tokens as a side effect.
 */
export async function updateSession(request: NextRequest): Promise<SessionUpdate> {
  let response = NextResponse.next({ request });
  const { url, anonKey } = getSupabasePublicConfig();

  const supabase = createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
        // Keep CDN/browser caches from serving one user's session to another.
        if (headers) for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
      },
    },
  });

  const { data, error } = await supabase.auth.getClaims();
  const userId = !error && data?.claims?.sub ? data.claims.sub : null;
  return { response, userId };
}

/** Copy auth cookies (and cache headers) from one response onto another (e.g. a redirect). */
export function copyAuthState(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) to.cookies.set(cookie);
  for (const h of ["cache-control", "expires", "pragma"]) {
    const v = from.headers.get(h);
    if (v) to.headers.set(h, v);
  }
  return to;
}
