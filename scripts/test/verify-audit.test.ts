// Runs the real command a judge would run, on a real log file.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, generateSigningKey, OFFLINE_TEST_SIGNING_KEY, signVerdict } from "@wardy-agent/core";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
const AT = "2026-11-05T12:00:00.000Z";

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "wardy-agent-verify-"));
  dirs.push(dir);
  return join(dir, "audit.jsonl");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function verdict(decision: "ALLOW" | "BLOCK", key: string) {
  return signVerdict(
    {
      verdictId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      mode: "pay",
      requestHash: "a".repeat(64),
      payee: "acme-sh0p.near",
      chain: "near",
      asset: "nep141:wrap.near",
      amount: "2",
      decision,
      riskScore: 90,
      signals: [],
      reasons: ["test"],
      createdAt: AT,
    },
    key,
  );
}

async function writeLog(path: string, key = OFFLINE_TEST_SIGNING_KEY) {
  const log = new AuditLog(path);
  log.append({ type: "verdict", at: AT, verdict: await verdict("ALLOW", key) });
  log.append({ type: "verdict", at: AT, verdict: await verdict("BLOCK", key) });
  log.append({ type: "freeze", at: AT });
}

function run(path: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/verify-audit.ts", path], { encoding: "utf8" });
}

describe("npm run verify-audit", () => {
  it("passes an untouched log and reports the counts", async () => {
    const path = tempFile();
    await writeLog(path);
    const result = run(path);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("audit chain valid, 3 entries, 2 signatures valid");
  });

  it("labels the public offline test key", async () => {
    const path = tempFile();
    await writeLog(path);
    expect(run(path).stdout).toContain("(the public offline test key)");
  });

  it("doesn't label a real key that way", async () => {
    const path = tempFile();
    await writeLog(path, generateSigningKey());
    expect(run(path).stdout).not.toContain("offline test key");
  });

  it("fails when someone turns a BLOCK into an ALLOW", async () => {
    const path = tempFile();
    await writeLog(path);
    const original = readFileSync(path, "utf8");
    const forged = original.replace('"decision":"BLOCK"', '"decision":"ALLOW"');
    expect(forged).not.toBe(original);
    writeFileSync(path, forged);
    const result = run(path);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("audit chain INVALID at line 2");
  });

  it("fails when a line is removed", async () => {
    const path = tempFile();
    await writeLog(path);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    lines.splice(1, 1);
    writeFileSync(path, `${lines.join("\n")}\n`);
    expect(run(path).status).toBe(1);
  });

  it("explains itself when there's no log yet", () => {
    const result = run(join(tmpdir(), "wardy-agent-no-such-log.jsonl"));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No audit log");
  });
});
