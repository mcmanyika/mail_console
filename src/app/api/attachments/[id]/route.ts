import { NextResponse, type NextRequest } from "next/server";
import { requireMailboxAccess, AuthzError } from "@/lib/auth/authz";
import { getCurrentUser } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Authorised attachment download. The attachments row is read through the
 * caller's RLS client (visible only if they can read the parent message's
 * mailbox), a mailbox grant is re-checked, and only then is a 60-second signed
 * URL minted with the service role. Platform admins get nothing from this.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = await createClient();
  const { data: att } = await supabase
    .from("attachments")
    .select("id, message_id, storage_path, filename, mime_type")
    .eq("id", id)
    .maybeSingle();
  if (!att) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { data: msg } = await supabase.from("messages").select("mailbox_id").eq("id", att.message_id).maybeSingle();
  if (!msg) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    await requireMailboxAccess(supabase, user.id, msg.mailbox_id, "read");
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    throw e;
  }

  const inline = request.nextUrl.searchParams.get("inline") === "1";
  const { data, error } = await createAdminClient()
    .storage.from("attachments")
    .createSignedUrl(att.storage_path, 60, inline ? undefined : { download: att.filename });
  if (error || !data) return NextResponse.json({ error: "File unavailable" }, { status: 404 });
  const res = NextResponse.redirect(data.signedUrl, 302);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
