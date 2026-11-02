import { describe, expect, it } from "vitest";
import { WORKSPACE } from "../src/index.js";

describe("workspace", () => {
  it("resolves", () => {
    expect(WORKSPACE).toBe("@wardy-agent/core");
  });
});
