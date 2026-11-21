import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/types/database";

/**
 * Writes an audit log row (service role: end users have no INSERT policy).
 * Metadata must never contain message content — ids and field names only.
 * Failures are logged but never block the action that triggered them.
 */
export async function writeAudit(
  admin: AdminClient,
  entry: {
    workspaceId: string | null;
    actorUserId: string | null;
    action: string;
    resourceType?: string;
    resourceId?: string;
    metadata?: Record<string, Json | undefined>;
  },
): Promise<void> {
  const { error } = await admin.from("audit_logs").insert({
    workspace_id: entry.workspaceId,
    actor_user_id: entry.actorUserId,
    action: entry.action,
    resource_type: entry.resourceType ?? null,
    resource_id: entry.resourceId ?? null,
    metadata: (entry.metadata ?? {}) as Json,
  });
  if (error) console.error(`[audit] failed to write ${entry.action}: ${error.message}`);
}
