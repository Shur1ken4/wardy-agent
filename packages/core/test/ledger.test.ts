import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ledger, samePayee } from "../src/ledger.js";
import { generateSigningKey, signVerdict } from "../src/sign.js";
import { makeSettled, makeUnsignedVerdict, NOW, OWNER } from "./helpers.js";

const dirs: string[] = [];

function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), "wardy-agent-ledger-"));
  dirs.push(dir);
  return join(dir, "ledger.jsonl");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const requestRecord = (requestId: string) => ({
  requestId,
  ownerId: OWNER,
  agentId: "bot",
  payee: "a.near",
  chain: "near",
  createdAt: NOW.toISOString(),
});

describe("Ledger", () => {
  it("keeps each owner's records apart", () => {
    const ledger = new Ledger();
    ledger.recordSettled(makeSettled());
    ledger.recordSettled(makeSettled({ ownerId: "other.near" }));
    expect(ledger.snapshot(OWNER).settled).toHaveLength(1);
    expect(ledger.snapshot("nobody.near").settled).toHaveLength(0);
  });

  it("counts known payees from settled payments", () => {
    const ledger = new Ledger();
    ledger.recordSettled(makeSettled());
    ledger.recordSettled(makeSettled());
    ledger.recordSettled(makeSettled({ payee: "other.near" }));
    expect(ledger.knownPayees(OWNER)).toEqual([
      { accountId: "acme-shop.near", chain: "near", paidCount: 2 },
      { accountId: "other.near", chain: "near", paidCount: 1 },
    ]);
  });

  it("a request alone doesn't make a payee known", () => {
    const ledger = new Ledger();
    ledger.recordRequest(requestRecord("r1"));
    expect(ledger.knownPayees(OWNER)).toEqual([]);
  });

  it("treats EVM addresses that differ only in case as one payee", () => {
    const lower = { payee: "0xabcdef0000000000000000000000000000000001", chain: "base" };
    const upper = { payee: "0xABCDEF0000000000000000000000000000000001", chain: "base" };
    expect(samePayee(lower, upper)).toBe(true);
  });

  it("doesn't treat NEAR accounts or different chains that way", () => {
    expect(samePayee({ payee: "a.near", chain: "near" }, { payee: "A.near", chain: "near" })).toBe(false);
    expect(samePayee({ payee: "0xabc", chain: "base" }, { payee: "0xabc", chain: "ethereum" })).toBe(false);
  });

  it("finds verdicts by id and by request, most recent first", async () => {
    const ledger = new Ledger();
    const first = await signVerdict(makeUnsignedVerdict(), generateSigningKey());
    const second = await signVerdict(makeUnsignedVerdict(), generateSigningKey());
    ledger.saveVerdict(first);
    ledger.saveVerdict(second);
    expect(ledger.verdictById(first.verdictId)).toEqual(first);
    expect(ledger.verdictByRequest(second.requestId)).toEqual(second);
    expect(ledger.recentVerdicts().map((verdict) => verdict.verdictId)).toEqual([second.verdictId, first.verdictId]);
    expect(ledger.recentVerdicts(1)).toHaveLength(1);
  });

  it("reloads everything from disk after a restart", async () => {
    const path = tempPath();
    const verdict = await signVerdict(makeUnsignedVerdict(), generateSigningKey());
    const ledger = new Ledger(path);
    ledger.recordRequest(requestRecord("r1"));
    ledger.recordSettled(makeSettled());
    ledger.saveVerdict(verdict);

    const reloaded = new Ledger(path);
    expect(reloaded.snapshot(OWNER).requests).toHaveLength(1);
    expect(reloaded.knownPayees(OWNER)).toHaveLength(1);
    expect(reloaded.verdictByRequest(verdict.requestId)).toEqual(verdict);
    expect(reloaded.requestRecord("r1")?.agentId).toBe("bot");
  });

  it("keeps the latest version of an updated verdict after a restart", async () => {
    const path = tempPath();
    const verdict = await signVerdict(makeUnsignedVerdict(), generateSigningKey());
    const ledger = new Ledger(path);
    ledger.saveVerdict(verdict);
    ledger.saveVerdict({ ...verdict, execution: { status: "executed", provider: "mock" } });
    expect(new Ledger(path).verdictById(verdict.verdictId)?.execution?.status).toBe("executed");
  });

  it("survives a crash mid-write by dropping only the torn last line", () => {
    const path = tempPath();
    new Ledger(path).recordSettled(makeSettled());
    appendFileSync(path, '{"kind":"settled","payment":{"requ');
    const reloaded = new Ledger(path);
    expect(reloaded.snapshot(OWNER).settled).toHaveLength(1);
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
    reloaded.recordSettled(makeSettled());
    expect(new Ledger(path).snapshot(OWNER).settled).toHaveLength(2);
  });

  it("refuses a file damaged in the middle, rather than guessing", () => {
    const path = tempPath();
    const ledger = new Ledger(path);
    ledger.recordSettled(makeSettled());
    ledger.recordSettled(makeSettled());
    const [first, second] = readFileSync(path, "utf8").trim().split("\n");
    writeFileSync(path, `${first}\n{broken\n${second}\n`);
    expect(() => new Ledger(path)).toThrow(/damaged at line 2/);
  });
});

describe("a capped, in-memory ledger", () => {
  it("keeps only the newest verdicts, and forgets their request ids with them", async () => {
    const ledger = new Ledger(undefined, { maxVerdicts: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const verdict = await signVerdict(makeUnsignedVerdict(), generateSigningKey());
      ids.push(verdict.verdictId);
      ledger.saveVerdict(verdict);
    }
    expect(ledger.verdictById(ids[0] as string)).toBeUndefined();
    expect(ledger.verdictById(ids[2] as string)).toBeDefined();
    expect(ledger.allVerdicts()).toHaveLength(2);
  });

  it("can't be given a file: a file is never cut", () => {
    expect(() => new Ledger("/tmp/never-written.jsonl", { maxVerdicts: 1 })).toThrow(/in memory/);
  });
});
