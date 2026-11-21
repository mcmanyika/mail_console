import { describe, expect, it } from "vitest";
import {
  extractBearerToken,
  generateApiKey,
  generateInviteToken,
  hashApiKey,
  hashInviteToken,
  parseApiKey,
  verifyApiKey,
} from "./api-keys";

describe("api keys", () => {
  it("generates well-formed, unique keys whose hash verifies", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).toMatch(/^mck_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(a.key).not.toBe(b.key);
    expect(a.keyPrefix).toBe(a.key.slice(0, 12));
    expect(a.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyApiKey(a.key, a.keyHash)).toBe(true);
    expect(verifyApiKey(b.key, a.keyHash)).toBe(false);
  });

  it("parses prefix and rejects malformed keys", () => {
    const { key, keyPrefix } = generateApiKey();
    expect(parseApiKey(key)).toEqual({ keyPrefix });
    expect(parseApiKey("mck_short")).toBeNull();
    expect(parseApiKey("sk_live_abcdefgh_" + "x".repeat(40))).toBeNull();
    expect(parseApiKey("")).toBeNull();
  });

  it("matches the demo key hashed in supabase/seed.sql (dev pepper)", () => {
    const demo = "mck_demo0001_demo-secret-do-not-use-0000000000";
    expect(parseApiKey(demo)).toEqual({ keyPrefix: "mck_demo0001" });
    expect(hashApiKey(demo)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("extracts bearer tokens", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
    expect(extractBearerToken("bearer abc123")).toBe("abc123");
    expect(extractBearerToken("Basic abc")).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
  });

  it("hashes invite tokens consistently", () => {
    const { token, tokenHash } = generateInviteToken();
    expect(hashInviteToken(token)).toBe(tokenHash);
    expect(hashInviteToken(token + "x")).not.toBe(tokenHash);
  });
});
