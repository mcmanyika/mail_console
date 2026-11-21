import { NextResponse } from "next/server";
import { apiError, handleGetEmail } from "@/lib/email/transactional";
import { createAdminClient } from "@/lib/supabase/admin";

/** GET /api/v1/emails/{id} — poll a message created by an integration in the key's workspace. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params; // Next 16: params is a Promise
  try {
    const result = await handleGetEmail(createAdminClient(), request, id);
    return NextResponse.json(result.body, { status: result.status, headers: result.headers });
  } catch (err) {
    console.error("[api/v1/emails/:id] fatal", err instanceof Error ? err.message : err);
    const e = apiError(500, "internal_error", "Unexpected error");
    return NextResponse.json(e.body, { status: e.status });
  }
}
