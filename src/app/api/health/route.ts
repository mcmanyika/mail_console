import { NextResponse } from "next/server";

/** Liveness probe — no auth, no secrets. */
export async function GET() {
  return NextResponse.json({ ok: true, service: "mail-console" });
}
