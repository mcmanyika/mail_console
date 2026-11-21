import { describe, expect, it } from "vitest";
import { isPublicPath, safeNextPath } from "./routes";

describe("routes", () => {
  it("knows public paths on segment boundaries", () => {
    expect(isPublicPath("/")).toBe(true);
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/api/webhooks/resend")).toBe(true);
    expect(isPublicPath("/auth/callback")).toBe(true);
    expect(isPublicPath("/loginx")).toBe(false);
    expect(isPublicPath("/dashboard")).toBe(false);
    expect(isPublicPath("/api/workspaces")).toBe(false);
  });
  it("blocks open redirects", () => {
    expect(safeNextPath("/inbox/1")).toBe("/inbox/1");
    expect(safeNextPath("//evil.example")).toBe("/dashboard");
    expect(safeNextPath("https://evil.example")).toBe("/dashboard");
    expect(safeNextPath("/\\evil.example")).toBe("/dashboard");
    expect(safeNextPath(null)).toBe("/dashboard");
  });
});
