import { describe, expect, it } from "vitest";
import { AiAssistError } from "./assist";

describe("AiAssistError", () => {
  it("carries a stable code for UI mapping", () => {
    const err = new AiAssistError("off", "disabled");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("disabled");
    expect(err.message).toBe("off");
  });
});
