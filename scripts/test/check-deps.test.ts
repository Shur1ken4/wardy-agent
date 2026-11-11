// The supply-chain check: every direct dependency is one exact version, so what a judge installs is what we tested.
import { describe, expect, it } from "vitest";
import { directDependencies, isExactVersion } from "../check-deps.mjs";

describe("dependencies", () => {
  it("every direct dependency is pinned to one exact version", () => {
    const loose = [...directDependencies()].filter(([, { version }]) => !isExactVersion(version as string)).map(([name]) => name);
    expect(loose).toEqual([]);
  });

  it("knows a range from a pin", () => {
    expect(isExactVersion("5.12.7")).toBe(true);
    expect(isExactVersion("^5.12.7")).toBe(false);
    expect(isExactVersion("~5.12.7")).toBe(false);
    expect(isExactVersion("latest")).toBe(false);
  });
});
