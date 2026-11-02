import { describe, expect, it } from "vitest";
import { generateSigningKey, OFFLINE_TEST_SIGNING_KEY, publicKeyOf, signVerdict, verifyVerdict } from "../src/sign.js";
import type { Verdict } from "../src/types.js";
import { makeUnsignedVerdict } from "./helpers.js";

const KEY = generateSigningKey();

describe("signVerdict and verifyVerdict", () => {
  it("signs a verdict that verifies, and names the public key", async () => {
    const verdict = await signVerdict(makeUnsignedVerdict(), KEY);
    expect(verdict.wardyPublicKey).toBe(await publicKeyOf(KEY));
    expect(await verifyVerdict(verdict)).toBe(true);
  });

  it("still verifies after a trip through JSON, as a stored verdict does", async () => {
    const verdict = await signVerdict(makeUnsignedVerdict({ ai: { used: false, attested: false, model: undefined } }), KEY);
    expect(await verifyVerdict(JSON.parse(JSON.stringify(verdict)))).toBe(true);
  });

  it.each<[string, Partial<Verdict>]>([
    ["the decision", { decision: "BLOCK" }],
    ["the mode", { mode: "check" }],
    ["the risk score", { riskScore: 99 }],
    ["the payee", { payee: "attacker.near" }],
    ["the amount", { amount: "2000" }],
    ["the asset", { asset: "nep141:other.near" }],
    ["the chain", { chain: "base" }],
    ["the request hash", { requestHash: "b".repeat(64) }],
    ["the reasons", { reasons: ["Looks fine"] }],
    ["the signals", { signals: [{ detector: "policy", code: "X", severity: "low", points: 0, message: "", evidence: {} }] }],
    ["the AI result", { ai: { used: true, attested: true, model: "made-up" } }],
    ["the time", { createdAt: "2020-01-01T00:00:00.000Z" }],
  ])("detects a change to %s", async (_name, change) => {
    const verdict = await signVerdict(makeUnsignedVerdict(), KEY);
    expect(await verifyVerdict({ ...verdict, ...change })).toBe(false);
  });

  it("allows later updates to execution and the report id, which the audit chain covers", async () => {
    const verdict = await signVerdict(makeUnsignedVerdict(), KEY);
    const updated: Verdict = {
      ...verdict,
      execution: { status: "executed", txHash: "abc", provider: "mock" },
      networkReportId: "report-1",
    };
    expect(await verifyVerdict(updated)).toBe(true);
  });

  it("a display field added to a verdict doesn't break verification", async () => {
    const verdict = await signVerdict(makeUnsignedVerdict(), KEY);
    expect(await verifyVerdict({ ...verdict, agentId: "procure-bot" } as Verdict)).toBe(true);
  });

  it("gives the same signature whether or not those later fields are present", async () => {
    const unsigned = makeUnsignedVerdict();
    const plain = await signVerdict(unsigned, KEY);
    const withExecution = await signVerdict({ ...unsigned, execution: { status: "refused", provider: "mock" } }, KEY);
    expect(withExecution.signature).toBe(plain.signature);
  });

  it("rejects a garbage signature without throwing", async () => {
    const verdict = await signVerdict(makeUnsignedVerdict(), KEY);
    expect(await verifyVerdict({ ...verdict, signature: "zz" })).toBe(false);
    expect(await verifyVerdict({ ...verdict, signature: "" })).toBe(false);
  });

  it("rejects a garbage public key without throwing", async () => {
    const verdict = await signVerdict(makeUnsignedVerdict(), KEY);
    expect(await verifyVerdict({ ...verdict, wardyPublicKey: "not-a-key" })).toBe(false);
  });

  it("a forged verdict is self-consistent, so pinning the expected key is what catches it", async () => {
    const forged = await signVerdict(makeUnsignedVerdict({ decision: "ALLOW" }), generateSigningKey());
    expect(await verifyVerdict(forged)).toBe(true);
    expect(await verifyVerdict(forged, await publicKeyOf(KEY))).toBe(false);
  });

  it("swapping in someone else's key fails", async () => {
    const verdict = await signVerdict(makeUnsignedVerdict(), KEY);
    const other = await publicKeyOf(generateSigningKey());
    expect(await verifyVerdict({ ...verdict, wardyPublicKey: other })).toBe(false);
  });
});

describe("keys", () => {
  it("generates a different 32-byte key each time", () => {
    const key = generateSigningKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe(generateSigningKey());
  });

  it("uses one fixed offline test key that can sign", async () => {
    expect(OFFLINE_TEST_SIGNING_KEY).toMatch(/^[0-9a-f]{64}$/);
    const verdict = await signVerdict(makeUnsignedVerdict(), OFFLINE_TEST_SIGNING_KEY);
    expect(await verifyVerdict(verdict, await publicKeyOf(OFFLINE_TEST_SIGNING_KEY))).toBe(true);
  });
});
