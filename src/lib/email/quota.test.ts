import { describe, expect, it } from "vitest";
import { countQuotaUnits, currentYearMonth, summarizeQuota } from "./quota";

describe("quota helpers", () => {
  it("formats the UTC year-month", () => {
    expect(currentYearMonth(new Date("2026-01-31T23:59:59Z"))).toBe("2026-01");
    expect(currentYearMonth(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12");
  });
  it("counts unique, case-insensitive recipients across to/cc/bcc", () => {
    expect(countQuotaUnits({ to: ["A@x.example", "b@x.example"], cc: ["a@x.example"], bcc: [" c@x.example "] })).toBe(3);
    expect(countQuotaUnits({})).toBe(0);
  });
  it("never reports negative remaining", () => {
    expect(summarizeQuota(10, 4, 3, "2026-11").remaining).toBe(3);
    expect(summarizeQuota(10, 8, 9, "2026-11").remaining).toBe(0);
  });
});
