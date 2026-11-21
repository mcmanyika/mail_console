import { NextResponse } from "next/server";
import { apiError, handleCreateEmail } from "@/lib/email/transactional";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * POST /api/v1/emails — transactional send (Bearer mck_… key).
 * Returns 202 { id, status: "queued" }; poll GET /api/v1/emails/{id}.
 * Public in proxy.ts (machine endpoint); authentication happens in the handler.
 */
export async function POST(request: Request) {
  try {
    const result = await handleCreateEmail(createAdminClient(), request);
    return NextResponse.json(result.body, { status: result.status, headers: result.headers });
  } catch (err) {
    console.error("[api/v1/emails] fatal", err instanceof Error ? err.message : err);
    const e = apiError(500, "internal_error", "Unexpected error");
    return NextResponse.json(e.body, { status: e.status });
  }
}
