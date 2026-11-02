import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AuditEntry, AuditLog, GENESIS_HASH, verifyAuditLines } from "../src/audit.js";
import { generateSigningKey, publicKeyOf, signVerdict } from "../src/sign.js";
import { makeUnsignedVerdict, NOW } from "./helpers.js";

const KEY = generateSigningKey();
const AT = NOW.toISOString();
const dirs: string[] = [];

function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), "wardy-agent-audit-"));
  dirs.push(dir);
  return join(dir, "nested", "audit.jsonl");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function logWithEntries() {
  const log = new AuditLog();
  log.append({ type: "verdict", at: AT, verdict: await signVerdict(makeUnsignedVerdict(), KEY) });
  log.append({ type: "execution", at: AT, verdictId: "v1", execution: { status: "executed", provider: "mock" } });
  log.append({ type: "freeze", at: AT });
  log.append({ type: "verdict", at: AT, verdict: await signVerdict(makeUnsignedVerdict(), KEY) });
  return log;
}

describe("AuditLog", () => {
  it("starts from the genesis hash and links each line to the one before", () => {
    const log = new AuditLog();
    const first = log.append({ type: "freeze", at: AT });
    const second = log.append({ type: "unfreeze", at: AT });
    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(second.prevHash).toBe(first.hash);
    expect(log.headHash()).toBe(second.hash);
  });

  it("writes one JSON line per entry", () => {
    const path = tempPath();
    const log = new AuditLog(path);
    log.append({ type: "freeze", at: AT });
    log.append({ type: "unfreeze", at: AT });
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("carries on the same chain after a restart", async () => {
    const path = tempPath();
    const first = new AuditLog(path);
    first.append({ type: "freeze", at: AT });
    const reopened = new AuditLog(path);
    reopened.append({ type: "unfreeze", at: AT });
    expect((await verifyAuditLines(reopened.lines())).valid).toBe(true);
  });

  it("refuses to continue from a damaged last line", () => {
    const path = tempPath();
    new AuditLog(path).append({ type: "freeze", at: AT });
    writeFileSync(path, `${readFileSync(path, "utf8")}{"broken`);
    expect(() => new AuditLog(path)).toThrow(/damaged/);
  });
});

describe("verifyAuditLines", () => {
  it("accepts an untouched chain and counts signatures", async () => {
    const log = await logWithEntries();
    expect(await verifyAuditLines(log.lines())).toEqual({
      valid: true,
      entries: 4,
      signaturesChecked: 2,
      publicKeys: [await publicKeyOf(KEY)],
    });
  });

  it("accepts an empty log", async () => {
    expect((await verifyAuditLines([])).valid).toBe(true);
  });

  it("catches a changed entry", async () => {
    const lines = (await logWithEntries()).lines();
    lines[1] = (lines[1] as string).replace('"executed"', '"failed"');
    expect(await verifyAuditLines(lines)).toMatchObject({ valid: false, problem: { line: 2 } });
  });

  it("catches a removed line", async () => {
    const lines = (await logWithEntries()).lines();
    lines.splice(1, 1);
    expect(await verifyAuditLines(lines)).toMatchObject({ valid: false, problem: { line: 2, reason: expect.stringContaining("follow") } });
  });

  it("catches reordered lines", async () => {
    const lines = (await logWithEntries()).lines();
    [lines[1], lines[2]] = [lines[2] as string, lines[1] as string];
    expect((await verifyAuditLines(lines)).valid).toBe(false);
  });

  it("catches an inserted line", async () => {
    const lines = (await logWithEntries()).lines();
    lines.splice(2, 0, lines[1] as string);
    expect((await verifyAuditLines(lines)).valid).toBe(false);
  });

  it("catches a line that isn't JSON", async () => {
    const lines = (await logWithEntries()).lines();
    lines[2] = "{oops";
    expect(await verifyAuditLines(lines)).toMatchObject({ valid: false, problem: { line: 3, reason: "not valid JSON" } });
  });

  it("catches a tampered hash, even with prevHash left right", async () => {
    const lines = (await logWithEntries()).lines();
    const record = JSON.parse(lines[2] as string);
    record.hash = "f".repeat(64);
    lines[2] = JSON.stringify(record);
    expect((await verifyAuditLines(lines)).valid).toBe(false);
  });

  it("catches a forged verdict even when the attacker rebuilds the whole chain", async () => {
    const unsigned = await signVerdict(makeUnsignedVerdict({ decision: "BLOCK" }), KEY);
    const forged = { ...unsigned, decision: "ALLOW" as const };
    const log = new AuditLog();
    log.append({ type: "verdict", at: AT, verdict: forged } as AuditEntry);
    expect(await verifyAuditLines(log.lines())).toMatchObject({ valid: false, problem: { reason: "verdict signature is invalid" } });
  });

  it("with a pinned key, catches a chain rebuilt with an attacker's key", async () => {
    const log = new AuditLog();
    log.append({ type: "verdict", at: AT, verdict: await signVerdict(makeUnsignedVerdict(), generateSigningKey()) });
    expect((await verifyAuditLines(log.lines())).valid).toBe(true);
    expect((await verifyAuditLines(log.lines(), await publicKeyOf(KEY))).valid).toBe(false);
  });

  it("reports every signing key, so a stranger's key stands out", async () => {
    const log = new AuditLog();
    log.append({ type: "verdict", at: AT, verdict: await signVerdict(makeUnsignedVerdict(), KEY) });
    log.append({ type: "verdict", at: AT, verdict: await signVerdict(makeUnsignedVerdict(), generateSigningKey()) });
    expect((await verifyAuditLines(log.lines())).publicKeys).toHaveLength(2);
  });
});
