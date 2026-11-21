import { NextResponse, type NextRequest } from "next/server";
import { hasSupabasePublicConfig, isProduction } from "@/lib/env";
import {
  DEFAULT_AUTHED_PATH,
  LOGIN_PATH,
  isApiPath,
  isGuestOnlyPath,
  isPublicPath,
} from "@/lib/routes";
import { copyAuthState, updateSession } from "@/lib/supabase/middleware";

/**
 * Next.js 16 renamed `middleware.ts` -> `proxy.ts` (export `proxy`, Node.js
 * runtime by default). Responsibilities:
 *   1. refresh the Supabase session cookies on every matched request;
 *   2. redirect signed-out users away from protected pages (401 JSON for /api);
 *   3. bounce signed-in users away from /login etc.
 *
 * It is an optimistic gate only. Real authorization (workspace role, mailbox
 * grants, platform admin) is enforced in server code + RLS — never rely on this.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!hasSupabasePublicConfig()) {
    if (isProduction()) {
      return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    }
    return NextResponse.next(); // local dev before .env.local exists
  }

  // Machine endpoints authenticate themselves; skip the auth round-trip.
  if (isPublicPath(pathname) && isApiPath(pathname)) {
    return NextResponse.next();
  }

  const { response, userId } = await updateSession(request);

  if (!userId && !isPublicPath(pathname)) {
    if (isApiPath(pathname)) {
      return copyAuthState(
        response,
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = LOGIN_PATH;
    url.search = "";
    url.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
    return copyAuthState(response, NextResponse.redirect(url));
  }

  if (userId && isGuestOnlyPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = DEFAULT_AUTHED_PATH;
    url.search = "";
    return copyAuthState(response, NextResponse.redirect(url));
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except Next internals and static assets.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|woff2?)$).*)",
  ],
};
