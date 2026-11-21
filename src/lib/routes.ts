/** Route constants + proxy access rules shared by `src/proxy.ts` and auth helpers. */

export const LOGIN_PATH = "/login";
export const DEFAULT_AUTHED_PATH = "/dashboard";

/** Paths (prefix match on a segment boundary) reachable without a session. */
export const PUBLIC_PATH_PREFIXES = [
  "/login",
  "/signup",
  "/auth", // OAuth/magic-link/confirm callbacks
  "/invite", // invitation acceptance landing (does its own token check)
  "/forgot-password",
  "/reset-password",
  // Machine-to-machine endpoints that authenticate themselves:
  "/api/webhooks", // Svix-signed provider webhooks
  "/api/v1", // transactional API (Bearer app key)
  "/api/cron", // outbox worker (CRON_SECRET)
  "/api/health",
] as const;

/** Exact public paths. */
export const PUBLIC_EXACT_PATHS = ["/"] as const;

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isPublicPath(pathname: string): boolean {
  if ((PUBLIC_EXACT_PATHS as readonly string[]).includes(pathname)) return true;
  return PUBLIC_PATH_PREFIXES.some((p) => matchesPrefix(pathname, p));
}

/** Pages that a signed-in user should be bounced away from. */
export function isGuestOnlyPath(pathname: string): boolean {
  return ["/login", "/signup", "/forgot-password"].some((p) => matchesPrefix(pathname, p));
}

export function isApiPath(pathname: string): boolean {
  return matchesPrefix(pathname, "/api");
}

/** Only allow same-origin relative redirects (prevents open-redirect via ?next=). */
export function safeNextPath(next: string | null | undefined, fallback = DEFAULT_AUTHED_PATH): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  return next;
}
