import { describe, expect, it } from "vitest";
import { USDC_ASSET } from "../src/assets.js";
import { AuditLog } from "../src/audit.js";
import { type CheckerDeps, evaluatePayment } from "../src/checker.js";
import { decide } from "../src/decision.js";
import { unusualAmountSignals } from "../src/detectors/unusualAmount.js";
import { makeSignal } from "../src/config.js";
import { Ledger } from "../src/ledger.js";
import { shouldPublishReport } from "../src/network/report.js";
import { makeRequest, makeSettled, makeUnsignedVerdict, minutesAgo, NOW } from "./helpers.js";

function history(...amounts: string[]) {
  return { settled: amounts.map((amount) => makeSettled({ amount })), requests: [] };
}

function codes(amount: string, ledger: ReturnType<typeof history>) {
  return unusualAmountSignals(makeRequest({ amount }), ledger, NOW).map((signal) => signal.code);
}

describe("unusualAmountSignals", () => {
  it("speaks up when a payee asks for far more than usual", () => {
    const [signal] = unusualAmountSignals(makeRequest({ amount: "2.5" }), history("0.1", "0.1", "0.1"), NOW);
    expect(signal?.code).toBe("AMOUNT_UNUSUAL_FOR_PAYEE");
    expect(signal?.message).toBe("This payee usually gets about 0.1. This asks for 2.5, about 25 times as much.");
    expect(signal?.evidence).toEqual({ usual: "0.1", highest: "0.1", paidCount: 3, amount: "2.5" });
  });

  it("needs 3 payments before it speaks of what's usual", () => {
    expect(codes("100", history())).toEqual([]);
    expect(codes("100", history("1", "1"))).toEqual(["AMOUNT_HIGH_FOR_LITTLE_HISTORY"]);
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
    const [signal] = unusualAmountSignals(makeRequest({ amount: "50" }), history("1", "1", "1", "40"), NOW);
    expect(signal?.evidence).toMatchObject({ usual: "1" });
  });

  it("takes the middle of an even number of payments, in exact decimals", () => {
    const [signal] = unusualAmountSignals(makeRequest({ amount: "9" }), history("0.1", "0.2", "0.3", "0.4"), NOW);
    expect(signal?.evidence).toMatchObject({ usual: "0.25" });
  });

  it("doesn't interrupt anyone over small change", () => {
    expect(codes("0.49", history("0.01", "0.01", "0.01"))).toEqual([]);
    expect(codes("0.5", history("0.01", "0.01", "0.01"))).toEqual(["AMOUNT_UNUSUAL_FOR_PAYEE"]);
  });

  it("doesn't use one asset's history to judge another", () => {
    const [signal] = unusualAmountSignals(makeRequest({ asset: USDC_ASSET, amount: "100" }), history("1", "1", "1"), NOW);
    expect(signal?.code).toBe("AMOUNT_FIRST_IN_THIS_ASSET");
  });

  it("only compares the same payee", () => {
    expect(unusualAmountSignals(makeRequest({ payee: "globex-supply.near", amount: "100" }), history("1", "1", "1"), NOW)).toEqual([]);
  });

  it("a payment custody couldn't confirm doesn't count as what's usual", () => {
    const ledger = { settled: [makeSettled({ amount: "1" }), makeSettled({ amount: "1" }), makeSettled({ amount: "9", uncertain: true })], requests: [] };
    expect(unusualAmountSignals(makeRequest({ amount: "2" }), ledger, NOW)).toEqual([]);
    expect(unusualAmountSignals(makeRequest({ amount: "2.1" }), ledger, NOW)[0]?.code).toBe("AMOUNT_HIGH_FOR_LITTLE_HISTORY");
  });

  it("copes with a history of zero amounts", () => {
    expect(codes("100", history("0", "0", "0"))).toEqual([]);
  });
});

describe("a payee with little history", () => {
  it("asks only when it's more than double the most they've had", () => {
    expect(codes("2", history("1"))).toEqual([]);
    expect(codes("2.01", history("1"))).toEqual(["AMOUNT_HIGH_FOR_LITTLE_HISTORY"]);
    expect(unusualAmountSignals(makeRequest({ amount: "2.01" }), history("1"), NOW)[0]?.message).toContain("only once");
    expect(unusualAmountSignals(makeRequest({ amount: "5" }), history("1", "2"), NOW)[0]?.message).toContain("only 2 times");
  });

  it("doesn't interrupt anyone over small change", () => {
    expect(codes("0.49", history("0.01"))).toEqual([]);
  });

  it("a first payment in a new asset asks, unless it's small", () => {
    const usdc = (amount: string) => unusualAmountSignals(makeRequest({ asset: USDC_ASSET, amount }), history("1"), NOW).map((signal) => signal.code);
    expect(usdc("0.5")).toEqual(["AMOUNT_FIRST_IN_THIS_ASSET"]);
    expect(usdc("0.49")).toEqual([]);
  });

  it("a payee never paid is left to the new-payee rule", () => {
    expect(unusualAmountSignals(makeRequest({ payee: "someone-new.near", amount: "100" }), history("1"), NOW)).toEqual([]);
  });
});

describe("the last 24 hours", () => {
  const DAY = 24 * 60;
  const paid = (amount: string, ago: number) => makeSettled({ amount, settledAt: minutesAgo(ago) });
  const day = (amount: string, settled: ReturnType<typeof paid>[]) => unusualAmountSignals(makeRequest({ amount }), { settled, requests: [] }, NOW);
  const week = [paid("0.1", 7 * DAY), paid("0.1", 6 * DAY), paid("0.1", 5 * DAY)];

  it("speaks up when many ordinary payments add up to far more than the busiest day", () => {
    const today = [paid("0.2", 60), paid("0.2", 30)];
    const [signal] = day("0.2", [...week, ...today]);
    expect(signal?.code).toBe("AMOUNT_UNUSUAL_DAY_FOR_PAYEE");
    expect(signal?.evidence).toEqual({ today: "0.6", busiest: "0.1", amount: "0.2" });
    expect(signal?.message).toBe("This would make 0.6 to this payee in 24 hours. Their busiest day before was 0.1.");
  });

  it("doesn't speak up under the size worth asking about", () => {
    expect(day("0.2", [...week, paid("0.2", 60)])).toEqual([]);
  });

  it("a payee that's always this busy stays quiet", () => {
    const busyDay = [paid("1", 3 * DAY), paid("1", 3 * DAY - 60), paid("1", 3 * DAY - 120)];
    expect(day("1", [...busyDay, paid("1", 60), paid("1", 30)])).toEqual([]);
  });

  it("with no earlier day to compare, it says nothing", () => {
    expect(day("1", [paid("1", 90), paid("1", 60), paid("1", 30)])).toEqual([]);
  });

  it("the window really is 24 hours: yesterday's money becomes the yardstick", () => {
    expect(day("0.45", [paid("0.45", DAY + 1), paid("0.45", DAY + 2), paid("0.45", DAY + 3)])).toEqual([]);
  });

  it("an unconfirmed payment counts towards today, in case it went out", () => {
    const [signal] = day("0.2", [...week, paid("0.2", 60), makeSettled({ amount: "0.3", settledAt: minutesAgo(30), uncertain: true })]);
    expect(signal?.evidence).toMatchObject({ today: "0.7" });
  });
});

describe("what it can decide", () => {
  const unusual = makeSignal("AMOUNT_UNUSUAL_FOR_PAYEE", "Unusual.");
  const known = makeSignal("KNOWN_PAYEE", "Known.");

  it.each(["AMOUNT_UNUSUAL_DAY_FOR_PAYEE", "AMOUNT_FIRST_IN_THIS_ASSET", "AMOUNT_HIGH_FOR_LITTLE_HISTORY", "CONTEXT_AMOUNT_MISMATCH"] as const)("%s only asks, however low the score", (code) => {
    expect(decide([known, makeSignal(code, "Asks.")]).decision).toBe("HOLD");
  });

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
