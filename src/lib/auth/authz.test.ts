import { describe, expect, it } from "vitest";
import { canManageRole, effectiveMailboxPermission, integrationMayUseMailbox, permissionAllows, roleAtLeast } from "./authz";

describe("authz rules", () => {
  it("ranks roles", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("admin", "owner")).toBe(false);
    expect(roleAtLeast("member", "member")).toBe(true);
    expect(roleAtLeast(null, "member")).toBe(false);
  });

  it("requires an explicit grant even for owners/admins", () => {
    expect(effectiveMailboxPermission("owner", null)).toBeNull();
    expect(effectiveMailboxPermission("admin", "read")).toBe("read");
    expect(effectiveMailboxPermission("owner", "read_send")).toBe("read_send");
    expect(effectiveMailboxPermission("member", "read")).toBe("read");
    expect(effectiveMailboxPermission("member", null)).toBeNull();
  });

  it("checks permission vs action", () => {
    expect(permissionAllows("read", "read")).toBe(true);
    expect(permissionAllows("read", "send")).toBe(false);
    expect(permissionAllows("read_send", "send")).toBe(true);
    expect(permissionAllows(null, "read")).toBe(false);
  });

  it("limits who can manage which roles", () => {
    expect(canManageRole("owner", "owner")).toBe(true);
    expect(canManageRole("admin", "owner")).toBe(false);
    expect(canManageRole("admin", "member")).toBe(true);
    expect(canManageRole("member", "member")).toBe(false);
  });

  it("scopes integrations to their workspace/mailbox", () => {
    const mb = { id: "m1", workspace_id: "w1" };
    expect(integrationMayUseMailbox({ allowed_mailbox_id: null, workspace_id: "w1" }, mb)).toBe(true);
    expect(integrationMayUseMailbox({ allowed_mailbox_id: "m1", workspace_id: "w1" }, mb)).toBe(true);
    expect(integrationMayUseMailbox({ allowed_mailbox_id: "m2", workspace_id: "w1" }, mb)).toBe(false);
    expect(integrationMayUseMailbox({ allowed_mailbox_id: null, workspace_id: "w2" }, mb)).toBe(false);
  });
});
