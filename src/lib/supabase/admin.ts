import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabasePublicConfig, getSupabaseServiceRoleKey } from "@/lib/env";
import type { Database } from "@/lib/types/database";

export type AdminClient = SupabaseClient<Database>;

let cached: AdminClient | undefined;

/**
 * SERVICE-ROLE client. BYPASSES ROW LEVEL SECURITY.
 *
 * Server-only: never import this from a Client Component or pass the client to
 * one. Every use must perform its own authorization first (see lib/auth/authz).
 * Use for: webhooks, the outbox worker, API-key requests, invitations,
 * provider-state writes, audit logs.
 */
export function createAdminClient(): AdminClient {
  if (typeof window !== "undefined") {
    throw new Error("createAdminClient() must never run in the browser");
  }
  if (cached) return cached;
  const { url } = getSupabasePublicConfig();
  cached = createSupabaseClient<Database>(url, getSupabaseServiceRoleKey(), {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  return cached;
}
