import { generateApiKey } from "@/lib/crypto/api-keys";
import { FakeDb } from "./fake-admin";

/**
 * Two isolated tenants for tests (all reserved `.example` hosts):
 *   workspace A: a.example   mailboxes support@ (A1), hello@ (A2)   limit 100
 *   workspace B: b.example   mailbox   support@ (B1)               limit 100
 */
export function seedWorld(db = new FakeDb()) {
  const id = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, "0")}`;

  const wsA = db.seed("workspaces", {
    id: id("a1"),
    name: "Workspace A",
    slug: "ws-a",
    status: "active",
    plan: "custom",
    monthly_sending_limit: 100,
    ai_enabled: false,
    ai_instructions: null,
    monthly_ai_limit: 200,
  });
  const wsB = db.seed("workspaces", {
    id: id("b1"),
    name: "Workspace B",
    slug: "ws-b",
    status: "active",
    plan: "custom",
    monthly_sending_limit: 100,
    ai_enabled: false,
    ai_instructions: null,
    monthly_ai_limit: 200,
  });

  const domA = db.seed("domains", { id: id("da"), workspace_id: wsA.id, hostname: "a.example", send_status: "verified", inbound_status: "verified", resend_domain_id: "mock_domain_a" });
  const domB = db.seed("domains", { id: id("db"), workspace_id: wsB.id, hostname: "b.example", send_status: "verified", inbound_status: "verified", resend_domain_id: "mock_domain_b" });

  const mbA1 = db.seed("mailboxes", { id: id("ca1"), workspace_id: wsA.id, domain_id: domA.id, address: "support@a.example", display_name: "A Support", enabled: true });
  const mbA2 = db.seed("mailboxes", { id: id("ca2"), workspace_id: wsA.id, domain_id: domA.id, address: "hello@a.example", display_name: "A Hello", enabled: true });
  const mbB1 = db.seed("mailboxes", { id: id("cb1"), workspace_id: wsB.id, domain_id: domB.id, address: "support@b.example", display_name: "B Support", enabled: true });

  // users: sender (A, read_send on A1 + read on A2), reader (A, read-only A1), outsider (B), admin (platform), noGrant (A member, no grants)
  const users = {
    sender: id("e1"),
    reader: id("e2"),
    outsider: id("e3"),
    platformAdmin: id("e4"),
    noGrant: id("e5"),
  };
  db.seed("platform_admins", { user_id: users.platformAdmin });

  const member = (n: string, ws: string, user: string, role = "member") =>
    db.seed("workspace_memberships", { id: id(n), workspace_id: ws, user_id: user, role });
  const msSender = member("f1", wsA.id as string, users.sender);
  const msReader = member("f2", wsA.id as string, users.reader);
  member("f3", wsB.id as string, users.outsider, "owner");
  member("f5", wsA.id as string, users.noGrant, "owner"); // owner WITHOUT mailbox grants: must not read mail

  const grant = (ms: string, mb: string, ws: string, permission: "read" | "read_send") =>
    db.seed("mailbox_access", { workspace_id: ws, membership_id: ms, mailbox_id: mb, permission });
  grant(msSender.id as string, mbA1.id as string, wsA.id as string, "read_send");
  grant(msSender.id as string, mbA2.id as string, wsA.id as string, "read");
  grant(msReader.id as string, mbA1.id as string, wsA.id as string, "read");

  // API keys
  const keyA = generateApiKey();
  const integrationA = db.seed("app_integrations", { workspace_id: wsA.id, name: "A app", allowed_mailbox_id: null, key_hash: keyA.keyHash, key_prefix: keyA.keyPrefix, last_used_at: null, revoked_at: null, created_by: null });
  const keyA1Only = generateApiKey();
  db.seed("app_integrations", { workspace_id: wsA.id, name: "A pinned to support@", allowed_mailbox_id: mbA1.id, key_hash: keyA1Only.keyHash, key_prefix: keyA1Only.keyPrefix, last_used_at: null, revoked_at: null, created_by: null });
  const keyRevoked = generateApiKey();
  db.seed("app_integrations", { workspace_id: wsA.id, name: "A revoked", allowed_mailbox_id: null, key_hash: keyRevoked.keyHash, key_prefix: keyRevoked.keyPrefix, last_used_at: null, revoked_at: new Date().toISOString(), created_by: null });
  const keyB = generateApiKey();
  const integrationB = db.seed("app_integrations", { workspace_id: wsB.id, name: "B app", allowed_mailbox_id: null, key_hash: keyB.keyHash, key_prefix: keyB.keyPrefix, last_used_at: null, revoked_at: null, created_by: null });

  db.seed("email_templates", {
    workspace_id: wsA.id,
    name: "welcome",
    subject: "Welcome, {{name}}",
    body_text: "Hi {{name}}, your code is {{code}}.",
    body_html: "<p>Hi {{name}}, your code is <b>{{code}}</b>.</p>",
    variables: ["name", "code"],
  });

  return {
    db,
    admin: db.client(),
    ids: { wsA: wsA.id as string, wsB: wsB.id as string, mbA1: mbA1.id as string, mbA2: mbA2.id as string, mbB1: mbB1.id as string, domA: domA.id as string },
    users,
    keys: { a: keyA.key, a1Only: keyA1Only.key, revoked: keyRevoked.key, b: keyB.key },
    integrations: { a: integrationA.id as string, b: integrationB.id as string },
  };
}

export type World = ReturnType<typeof seedWorld>;
