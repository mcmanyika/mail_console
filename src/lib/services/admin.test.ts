import { beforeEach, describe, expect, it } from "vitest";
import { AuthzError } from "@/lib/auth/authz";
import { hashInviteToken } from "@/lib/crypto/api-keys";
import { seedWorld, type World } from "@/lib/testing/world";
import {
  createWorkspace,
  inviteOwner,
  reinstateWorkspace,
  setWorkspaceLimits,
  slugify,
  suspendWorkspace,
  type AdminCtx,
} from "./admin";

let w: World;
const asAdmin = (): AdminCtx => ({ admin: w.admin, userId: w.users.platformAdmin });
const asUser = (userId: string): AdminCtx => ({ admin: w.admin, userId });

beforeEach(() => {
  w = seedWorld();
});

describe("platform-admin gate", () => {
  it("every operation rejects non-platform-admins (including workspace owners) before touching data", async () => {
    for (const user of [w.users.noGrant /* workspace owner */, w.users.sender, w.users.outsider]) {
      const ctx = asUser(user);
      await expect(createWorkspace(ctx, { name: "X" })).rejects.toBeInstanceOf(AuthzError);
      await expect(inviteOwner(ctx, { workspaceId: w.ids.wsA, email: "a@b.example" })).rejects.toBeInstanceOf(AuthzError);
      await expect(suspendWorkspace(ctx, { workspaceId: w.ids.wsA })).rejects.toBeInstanceOf(AuthzError);
      await expect(reinstateWorkspace(ctx, { workspaceId: w.ids.wsA })).rejects.toBeInstanceOf(AuthzError);
      await expect(setWorkspaceLimits(ctx, { workspaceId: w.ids.wsA, monthlySendingLimit: 1 })).rejects.toBeInstanceOf(AuthzError);
    }
    expect(w.db.rows("workspaces")).toHaveLength(2);
    expect(w.db.rows("workspaces").find((x) => x.id === w.ids.wsA)).toMatchObject({ status: "active", monthly_sending_limit: 100 });
    expect(w.db.rows("audit_logs")).toHaveLength(0);
  });
});

describe("workspace lifecycle", () => {
  it("creates an active workspace with a slug and limit, and audits it", async () => {
    const { workspace, owner } = await createWorkspace(asAdmin(), { name: "Grace & Co.", monthlySendingLimit: 500 });
    expect(workspace).toMatchObject({ name: "Grace & Co.", slug: "grace-co", status: "active", monthly_sending_limit: 500 });
    expect(owner).toBeNull();
    expect(w.db.rows("audit_logs")[0]).toMatchObject({ action: "workspace.created", actor_user_id: w.users.platformAdmin, workspace_id: workspace.id });
  });

  it("rejects duplicate slugs and invalid input", async () => {
    await expect(createWorkspace(asAdmin(), { name: "Dup", slug: "ws-a" })).rejects.toMatchObject({ code: "slug_taken", status: 409 });
    await expect(createWorkspace(asAdmin(), { name: "" })).rejects.toThrow();
    await expect(createWorkspace(asAdmin(), { name: "!!!" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(createWorkspace(asAdmin(), { name: "ok", monthlySendingLimit: -1 })).rejects.toThrow();
    expect(slugify("  Ünïcode Name  ")).toBe("unicode-name");
  });

  it("invites a new owner with a single-use token (only its hash is stored)", async () => {
    const { workspace, owner } = await createWorkspace(asAdmin(), { name: "Newco", ownerEmail: "Founder@Newco.example" });
    expect(owner?.kind).toBe("invitation_created");
    if (owner?.kind !== "invitation_created") throw new Error("unreachable");
    const token = owner.inviteUrl.split("/invite/")[1];
    expect(token.length).toBeGreaterThanOrEqual(40);

    const [inv] = w.db.rows("workspace_invitations");
    expect(inv).toMatchObject({ workspace_id: workspace.id, email: "founder@newco.example", role: "owner", invited_by: w.users.platformAdmin });
    expect(inv.token_hash).toBe(hashInviteToken(token));
    expect(JSON.stringify(inv)).not.toContain(token);
    expect(JSON.stringify(w.db.rows("audit_logs"))).not.toContain(token);
  });

  it("re-inviting rotates the token and revokes the previous pending invitation", async () => {
    const first = await inviteOwner(asAdmin(), { workspaceId: w.ids.wsA, email: "x@y.example" });
    const second = await inviteOwner(asAdmin(), { workspaceId: w.ids.wsA, email: "x@y.example" });
    expect(first.kind).toBe("invitation_created");
    expect(second.kind).toBe("invitation_created");
    const invs = w.db.rows("workspace_invitations");
    expect(invs).toHaveLength(2);
    expect(invs.filter((i) => !i.revoked_at)).toHaveLength(1);
  });

  it("makes an existing user an owner immediately (no mailbox grant => still no mail access)", async () => {
    w.db.seed("profiles", { id: w.users.outsider, email: "owner-b@b.example" });
    const res = await inviteOwner(asAdmin(), { workspaceId: w.ids.wsA, email: "owner-b@b.example" });
    expect(res).toEqual({ kind: "membership_created", userId: w.users.outsider });
    expect(w.db.rows("workspace_memberships").find((m) => m.workspace_id === w.ids.wsA && m.user_id === w.users.outsider)).toMatchObject({ role: "owner" });
    expect(w.db.rows("mailbox_access").some((g) => g.membership_id === w.db.rows("workspace_memberships").find((m) => m.workspace_id === w.ids.wsA && m.user_id === w.users.outsider)!.id)).toBe(false);
  });

  it("suspends and reinstates, recording who and why (never content)", async () => {
    const s = await suspendWorkspace(asAdmin(), { workspaceId: w.ids.wsA, reason: "abuse report #12" });
    expect(s.status).toBe("suspended");
    const log = w.db.rows("audit_logs").find((l) => l.action === "workspace.suspended")!;
    expect(log).toMatchObject({ workspace_id: w.ids.wsA, actor_user_id: w.users.platformAdmin });
    expect(log.metadata).toMatchObject({ reason: "abuse report #12", previous_status: "active" });

    expect((await reinstateWorkspace(asAdmin(), { workspaceId: w.ids.wsA })).status).toBe("active");
    await expect(suspendWorkspace(asAdmin(), { workspaceId: "00000000-0000-4000-8000-0000000000ff" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("sets limits with validation", async () => {
    const ws = await setWorkspaceLimits(asAdmin(), { workspaceId: w.ids.wsA, monthlySendingLimit: 42 });
    expect(ws.monthly_sending_limit).toBe(42);
    expect(w.db.rows("audit_logs").find((l) => l.action === "workspace.limits_changed")!.metadata).toMatchObject({ previous_monthly_sending_limit: 100, monthly_sending_limit: 42 });
    await expect(setWorkspaceLimits(asAdmin(), { workspaceId: w.ids.wsA, monthlySendingLimit: 1.5 })).rejects.toThrow();
    await expect(setWorkspaceLimits(asAdmin(), { workspaceId: w.ids.wsA, monthlySendingLimit: -5 })).rejects.toThrow();
  });
});
