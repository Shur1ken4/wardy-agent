import { describe, expect, it } from "vitest";
import { toAtomic } from "../src/amount.js";

describe("toAtomic", () => {
  it.each([
    ["1", 24, 10n ** 24n],
    ["0.1", 24, 10n ** 23n],
    ["0.000000000000000000000001", 24, 1n],
    ["2.5", 6, 2_500_000n],
    ["0.01", 6, 10_000n],
    ["0", 6, 0n],
    ["10.36", 24, 10_360_000_000_000_000_000_000_000n],
  ])("converts %s at %i decimals", (amount, decimals, expected) => {
    expect(toAtomic(amount, decimals)).toBe(expected);
  });

  it("keeps full precision where a float would round", () => {
    expect(toAtomic("0.123456789012345678901234", 24)).toBe(123456789012345678901234n);
  });

  it.each(["", "abc", "-1", "1,5", "1e3", ".5", "5.", "1.2.3", " 1", "0x10"])("rejects %j", (amount) => {
    expect(() => toAtomic(amount, 24)).toThrow(/not an amount/);
  });

  it("rejects more decimals than the token has", () => {
    expect(() => toAtomic("0.1234567", 6)).toThrow(/too many decimal/);
  });
});
