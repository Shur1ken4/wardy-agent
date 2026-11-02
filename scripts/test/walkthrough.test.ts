// Runs the real command, the way someone following the README would.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("npm run walkthrough", () => {
  it("passes offline with no keys, no funds and no .env", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/walkthrough.ts"], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Everything was as expected.");
    expect(result.stdout).not.toContain("UNEXPECTED");
    expect(result.stdout).toContain("(mock ledger)");
  }, 60_000);
});
