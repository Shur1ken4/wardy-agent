import { describe, expect, it } from "vitest";
import { USDC_ASSET } from "../src/assets.js";
import { AuditLog } from "../src/audit.js";
import { type CheckerDeps, evaluatePayment } from "../src/checker.js";
import { decide } from "../src/decision.js";
import { unusualAmountSignals } from "../src/detectors/unusualAmount.js";
import { makeSignal } from "../src/config.js";
import { Ledger } from "../src/ledger.js";
import { shouldPublishReport } from "../src/network/report.js";
import { makeRequest, makeSettled, makeUnsignedVerdict, NOW } from "./helpers.js";

function history(...amounts: string[]) {
  return { settled: amounts.map((amount) => makeSettled({ amount })), requests: [] };
}

function codes(amount: string, ledger: ReturnType<typeof history>) {
  return unusualAmountSignals(makeRequest({ amount }), ledger).map((signal) => signal.code);
}

describe("unusualAmountSignals", () => {
  it("speaks up when a payee asks for far more than usual", () => {
    const [signal] = unusualAmountSignals(makeRequest({ amount: "2.5" }), history("0.1", "0.1", "0.1"));
    expect(signal?.code).toBe("AMOUNT_UNUSUAL_FOR_PAYEE");
    expect(signal?.message).toBe("This payee usually gets about 0.1. This asks for 2.5, about 25 times as much.");
    expect(signal?.evidence).toEqual({ usual: "0.1", highest: "0.1", paidCount: 3, amount: "2.5" });
  });

  it("says nothing until there's enough history to know what's usual", () => {
    expect(codes("100", history())).toEqual([]);
    expect(codes("100", history("1", "1"))).toEqual([]);
    expect(codes("100", history("1", "1", "1"))).toEqual(["AMOUNT_UNUSUAL_FOR_PAYEE"]);
  });

  it("the boundary is exactly three times the usual amount", () => {
    expect(codes("3", history("1", "1", "1"))).toEqual([]);
    expect(codes("3.000001", history("1", "1", "1"))).toEqual(["AMOUNT_UNUSUAL_FOR_PAYEE"]);
  });

  it("an ordinary bigger invoice isn't unusual", () => {
    expect(codes("2.9", history("2", "1.5", "2.5"))).toEqual([]);
  });

  it("an amount this payee has really had before isn't unusual, however rare", () => {
    expect(codes("10", history("1", "1", "1", "10"))).toEqual([]);
    expect(codes("10.01", history("1", "1", "1", "10"))).toEqual(["AMOUNT_UNUSUAL_FOR_PAYEE"]);
  });

  it("one large payment doesn't move what's usual", () => {
    const [signal] = unusualAmountSignals(makeRequest({ amount: "50" }), history("1", "1", "1", "40"));
    expect(signal?.evidence).toMatchObject({ usual: "1" });
  });

  it("takes the middle of an even number of payments, in exact decimals", () => {
    const [signal] = unusualAmountSignals(makeRequest({ amount: "9" }), history("0.1", "0.2", "0.3", "0.4"));
    expect(signal?.evidence).toMatchObject({ usual: "0.25" });
  });

  it("doesn't interrupt anyone over small change", () => {
    expect(codes("0.49", history("0.01", "0.01", "0.01"))).toEqual([]);
    expect(codes("0.5", history("0.01", "0.01", "0.01"))).toEqual(["AMOUNT_UNUSUAL_FOR_PAYEE"]);
  });

  it("only compares the same asset", () => {
    const ledger = history("1", "1", "1");
    expect(unusualAmountSignals(makeRequest({ asset: USDC_ASSET, amount: "100" }), ledger)).toEqual([]);
  });

  it("only compares the same payee", () => {
    expect(unusualAmountSignals(makeRequest({ payee: "globex-supply.near", amount: "100" }), history("1", "1", "1"))).toEqual([]);
  });

  it("a payment custody couldn't confirm doesn't count as what's usual", () => {
    const ledger = { settled: [makeSettled({ amount: "1" }), makeSettled({ amount: "1" }), makeSettled({ amount: "1", uncertain: true })], requests: [] };
    expect(unusualAmountSignals(makeRequest({ amount: "100" }), ledger)).toEqual([]);
  });

  it("copes with a history of zero amounts", () => {
    expect(codes("100", history("0", "0", "0"))).toEqual([]);
  });
});

describe("what it can decide", () => {
  const unusual = makeSignal("AMOUNT_UNUSUAL_FOR_PAYEE", "Unusual.");
  const known = makeSignal("KNOWN_PAYEE", "Known.");

  it("asks the owner, on a payee they really pay", () => {
    expect(decide([known, unusual])).toMatchObject({ decision: "HOLD", riskScore: 10, reasons: ["Unusual."] });
  });

  it("can't lower anything: other evidence still blocks", () => {
    const bypass = makeSignal("CONTEXT_BYPASS_ATTEMPT", "Bypass.");
    expect(decide([known, unusual, bypass]).decision).toBe("BLOCK");
  });

  it("never becomes a public report: it says nothing about the payee", () => {
    const verdict = { ...makeUnsignedVerdict({ decision: "BLOCK", signals: [unusual] }), signature: "", wardyPublicKey: "" };
    expect(shouldPublishReport(verdict)).toBe(false);
  });
});

describe("who can see it", () => {
  const ledger = new Ledger();
  for (let count = 0; count < 3; count += 1) ledger.recordSettled(makeSettled({ settledAt: "2026-10-01T00:00:00.000Z" }));
  const deps = {
    ledger,
    audit: new AuditLog(),
    policyFor: () => null,
    seedPayees: [],
    chainData: { getAccountFacts: async () => ({ accountId: "acme-shop.near", available: false }) },
    reportsFor: () => [],
    reportRules: { trustedReporters: new Set<string>(), verifyEvidence: async () => true, allowSeedReports: true },
    signingKey: "",
  } as unknown as CheckerDeps;
  const has = async (mode: "pay" | "check") => (await evaluatePayment(makeRequest({ amount: "100" }), deps, NOW, mode)).signals.some((signal) => signal.code === "AMOUNT_UNUSUAL_FOR_PAYEE");

  it("a payment gets it", async () => {
    expect(await has("pay")).toBe(true);
  });

  it("a check doesn't: anyone can send one, and trying amounts would reveal what you pay", async () => {
    expect(await has("check")).toBe(false);
  });
});
