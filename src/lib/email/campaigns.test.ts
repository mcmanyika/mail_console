import { describe, expect, it } from "vitest";
import { parseContactsCsv } from "./campaigns";

describe("parseContactsCsv", () => {
  it("parses email + name + custom fields", () => {
    const csv = `email,name,company\na@example.com,Ada Lovelace,Analytical\nb@example.com,Bob,\n`;
    const { contacts, errors } = parseContactsCsv(csv);
    expect(errors).toEqual([]);
    expect(contacts).toHaveLength(2);
    expect(contacts[0]).toMatchObject({
      email: "a@example.com",
      fullName: "Ada Lovelace",
      fields: { company: "Analytical", first_name: "Ada" },
    });
    expect(contacts[1]?.email).toBe("b@example.com");
  });

  it("dedupes and rejects bad emails", () => {
    const csv = `email\na@example.com\nA@example.com\nnot-an-email\n`;
    const { contacts, errors } = parseContactsCsv(csv);
    expect(contacts).toHaveLength(1);
    expect(errors.some((e) => /invalid email/i.test(e))).toBe(true);
  });

  it("requires an email column", () => {
    const { contacts, errors } = parseContactsCsv(`name\nAda`);
    expect(contacts).toHaveLength(0);
    expect(errors[0]).toMatch(/email column/i);
  });
});
