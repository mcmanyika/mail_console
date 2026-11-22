#!/usr/bin/env node
/**
 * Promote an email to platform superuser (platform_admins).
 *
 * Usage:
 *   node scripts/promote-platform-admin.mjs partsonmanyika@gmail.com
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the environment
 * or from .env.local in the repo root. Creates the Auth user if missing, ensures
 * a profiles row, upserts platform_admins, and prints a recovery link when a new
 * user was created.
 *
 * Platform admin ≠ mailbox access. This only unlocks /admin.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal() {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvLocal();

const emailArg = process.argv[2]?.trim().toLowerCase();
if (!emailArg || !emailArg.includes("@")) {
  console.error("Usage: node scripts/promote-platform-admin.mjs <email>");
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");

if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (.env.local)");
  process.exit(1);
}

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};

async function listUsers(page = 1) {
  const res = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=200`, { headers });
  if (!res.ok) throw new Error(`listUsers ${res.status}: ${await res.text()}`);
  return res.json();
}

async function findUser(email) {
  for (let page = 1; page <= 20; page++) {
    const data = await listUsers(page);
    const users = data.users ?? data;
    if (!Array.isArray(users)) throw new Error("Unexpected listUsers response");
    const user = users.find((u) => u.email?.toLowerCase() === email) ?? null;
    if (user || users.length < 200) return user;
  }
  return null;
}

async function main() {
  let user = await findUser(emailArg);
  let created = false;

  if (!user) {
    const createRes = await fetch(`${url}/auth/v1/admin/users`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        email: emailArg,
        email_confirm: true,
        user_metadata: { full_name: emailArg.split("@")[0] },
      }),
    });
    if (!createRes.ok) {
      throw new Error(`createUser ${createRes.status}: ${await createRes.text()}`);
    }
    const body = await createRes.json();
    user = body.user ?? body;
    created = true;
  }

  const profileRes = await fetch(`${url}/rest/v1/profiles?on_conflict=id`, {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      id: user.id,
      email: emailArg,
      full_name: user.user_metadata?.full_name ?? null,
    }),
  });
  if (!profileRes.ok) {
    throw new Error(`profile upsert ${profileRes.status}: ${await profileRes.text()}`);
  }

  const adminRes = await fetch(`${url}/rest/v1/platform_admins?on_conflict=user_id`, {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ user_id: user.id }),
  });
  if (!adminRes.ok) {
    throw new Error(`platform_admins upsert ${adminRes.status}: ${await adminRes.text()}`);
  }

  let recoveryLink = null;
  if (created) {
    const linkRes = await fetch(`${url}/auth/v1/admin/generate_link`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "recovery",
        email: emailArg,
        options: { redirect_to: `${appUrl}/` },
      }),
    });
    if (linkRes.ok) {
      const linkBody = await linkRes.json();
      recoveryLink = linkBody.action_link ?? linkBody.properties?.action_link ?? null;
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        email: emailArg,
        user_id: user.id,
        created,
        platform_admin: true,
        admin_url: `${appUrl}/admin`,
        recovery_link: recoveryLink,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
