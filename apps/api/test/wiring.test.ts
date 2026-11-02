import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFFLINE_TEST_SIGNING_KEY, publicKeyOf } from "@wardy-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { assertBalanceIsSafe, loadPolicy, OFFLINE_AGENT_TOKEN, OFFLINE_OWNER_TOKEN, wire } from "../src/wiring.js";

const dirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "wardy-agent-wiring-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const custody = { name: "fake", transfer: async () => ({ status: "failed" as const, provider: "fake" }) };

const LIVE_ENV = {
  WARDY_MODE: "live",
  NEAR_INTENTS_AGENT_API_KEY: "VALUE-MUST-NOT-LEAK-1",
  WARDY_AGENT_ID: "agent-1",
  WARDY_GRANT_TOKEN: "VALUE-MUST-NOT-LEAK-2",
  WARDY_SIGNING_KEY: "a".repeat(64),
  WARDY_AGENT_TOKEN: "VALUE-MUST-NOT-LEAK-3",
  WARDY_OWNER_TOKEN: "VALUE-MUST-NOT-LEAK-4",
};

describe("offline mode", () => {
  it("is the default, and needs nothing at all", async () => {
    const wiring = await wire({}, { dataDir: tempDir() });
    expect(wiring.mode).toBe("offline");
    expect(wiring.service.providerName).toBe("mock");
    expect(wiring.agentToken).toBe(OFFLINE_AGENT_TOKEN);
    expect(wiring.ownerToken).toBe(OFFLINE_OWNER_TOKEN);
    expect(await wiring.service.publicKey()).toBe(await publicKeyOf(OFFLINE_TEST_SIGNING_KEY));
  });

  it("really checks and pays on the mock ledger", async () => {
    const wiring = await wire({}, { dataDir: tempDir(), seedHistory: false });
    const verdict = await wiring.service.pay({
      requestId: crypto.randomUUID(),
      agentId: "bot",
      ownerId: wiring.service.fleetOwnerId,
      payee: "acme-shop.near",
      asset: "wNEAR",
      amount: "2",
      purpose: "first payment",
      createdAt: new Date().toISOString(),
    });
    expect(verdict.decision).toBe("HOLD");
  });

  it("gives the demo owner a past, so a lookalike has someone to imitate, and doesn't repeat it on restart", async () => {
    const dir = tempDir();
    const pay = (wiring: Awaited<ReturnType<typeof wire>>, payee: string, amount: string) =>
      wiring.service.pay({
        requestId: crypto.randomUUID(),
        agentId: "bot",
        ownerId: wiring.service.fleetOwnerId,
        payee,
        asset: "wNEAR",
        amount,
        purpose: "demo",
        createdAt: new Date().toISOString(),
      });
    const wiring = await wire({}, { dataDir: dir });
    const blocked = await pay(wiring, "acme-sh0p.near", "2");
    expect(blocked.decision).toBe("BLOCK");
    expect(blocked.reasons.join(" ")).toContain("3 times");
    const restarted = await wire({}, { dataDir: dir });
    expect((await pay(restarted, "acme-sh0p.near", "1")).reasons.join(" ")).toContain("3 times");
  });

  it("publishes a report when a BLOCK has enough evidence, and the next agent is protected", async () => {
    const wiring = await wire({}, { dataDir: tempDir() });
    const blocked = await wiring.service.pay({
      requestId: crypto.randomUUID(),
      agentId: "bot",
      ownerId: wiring.service.fleetOwnerId,
      payee: "acme-sh0p.near",
      asset: "wNEAR",
      amount: "2",
      purpose: "demo",
      createdAt: new Date().toISOString(),
    });
    expect(blocked.networkReportId).toBeDefined();
    expect(wiring.reports.reportsFor("acme-sh0p.near", "near")).toHaveLength(1);
    const other = await wiring.service.check({
      requestId: crypto.randomUUID(),
      agentId: "someone-elses-bot",
      ownerId: "someone-else.near",
      payee: "acme-sh0p.near",
      asset: "wNEAR",
      amount: "2",
      purpose: "demo",
      createdAt: new Date().toISOString(),
    });
    expect(other.decision).toBe("BLOCK");
    expect(other.signals.map((signal) => signal.code)).toContain("NETWORK_REPORTED_SCAM");
  });

  it("keeps each mode's records apart by default", async () => {
    const dir = tempDir();
    const wiring = await wire({ WARDY_DATA_DIR: join(dir, "here") });
    expect(wiring.dataDir).toBe(join(dir, "here"));
  });
});

describe("mode selection", () => {
  it("refuses an unknown mode", async () => {
    await expect(wire({ WARDY_MODE: "production" }, { dataDir: tempDir() })).rejects.toThrow(/offline, testnet or live/);
  });
});

describe("testnet mode", () => {
  it("creates its throw-away secrets once, privately, and keeps them", async () => {
    const dir = tempDir();
    const first = await wire({ WARDY_MODE: "testnet" }, { dataDir: dir, custody });
    const second = await wire({ WARDY_MODE: "testnet" }, { dataDir: dir, custody });
    expect(second.agentToken).toBe(first.agentToken);
    expect(first.agentToken).not.toBe(OFFLINE_AGENT_TOKEN);
    expect(JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8")).ownerToken).toBe(first.ownerToken);
  });

  it("prefers credentials from the environment", async () => {
    const wiring = await wire({ WARDY_MODE: "testnet", WARDY_AGENT_TOKEN: "mine" }, { dataDir: tempDir(), custody });
    expect(wiring.agentToken).toBe("mine");
  });
});

describe("live mode refuses to start unsafely", () => {
  it.each(["WARDY_SIGNING_KEY", "WARDY_AGENT_TOKEN", "WARDY_OWNER_TOKEN"])("without %s", async (name) => {
    const env = { ...LIVE_ENV, [name]: "" };
    await expect(wire(env, { dataDir: tempDir(), custody })).rejects.toThrow(new RegExp(name));
  });

  it.each(["NEAR_INTENTS_AGENT_API_KEY", "WARDY_AGENT_ID", "WARDY_GRANT_TOKEN"])("without %s", async (name) => {
    await expect(wire({ ...LIVE_ENV, [name]: "" }, { dataDir: tempDir() })).rejects.toThrow(new RegExp(name));
  });

  it("errors name the setting and never print a value", async () => {
    const error = await wire({ ...LIVE_ENV, WARDY_OWNER_TOKEN: "" }, { dataDir: tempDir(), custody }).catch((caught) => caught);
    expect(String(error.message)).not.toContain("VALUE-MUST-NOT-LEAK");
  });

  it("starts when everything is set", async () => {
    const wiring = await wire(LIVE_ENV, { dataDir: tempDir(), custody });
    expect(wiring.mode).toBe("live");
    expect(wiring.agentToken).toBe(LIVE_ENV.WARDY_AGENT_TOKEN);
  });

  it("refuses above the safety limit", async () => {
    const rich = { ...custody, balanceNearEquivalent: async () => 11 };
    await expect(wire(LIVE_ENV, { dataDir: tempDir(), custody: rich })).rejects.toThrow(/10 NEAR safety limit/);
  });

  it("starts at the limit, and above it only when told to", async () => {
    await expect(assertBalanceIsSafe({ ...custody, balanceNearEquivalent: async () => 10 }, false)).resolves.toBeUndefined();
    const rich = { ...custody, balanceNearEquivalent: async () => 500 };
    await expect(wire({ ...LIVE_ENV, WARDY_I_UNDERSTAND_RISK: "1" }, { dataDir: tempDir(), custody: rich })).resolves.toBeDefined();
  });

  it("fails closed when the balance can't be read", async () => {
    const broken = { ...custody, balanceNearEquivalent: () => Promise.reject(new Error("api down")) };
    await expect(wire(LIVE_ENV, { dataDir: tempDir(), custody: broken })).rejects.toThrow(/won't start/);
  });
});

describe("loadPolicy", () => {
  it("reads config/policy.json, with native transfers off", () => {
    expect(loadPolicy()).toMatchObject({ maxPerPayment: "5", dailyBudget: "40", approvalThreshold: "3", nativeNearTransfers: false });
  });
});
