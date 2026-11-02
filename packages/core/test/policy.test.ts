import { describe, expect, it } from "vitest";
import { normalizeAsset, USDC_ASSET, WNEAR_ASSET } from "../src/assets.js";
import { decide } from "../src/decision.js";
import type { LedgerSnapshot } from "../src/ledger.js";
import { DEFAULT_POLICY, type OwnerPolicy, OwnerPolicySchema, policySignals } from "../src/policy.js";
import type { PaymentRequest } from "../src/types.js";
import { makeRequest, makeSettled, minutesAgo, NOW } from "./helpers.js";

function codes(
  request: PaymentRequest = makeRequest(),
  policy: Partial<OwnerPolicy> = {},
  options: { known?: boolean; ledger?: Partial<LedgerSnapshot> } = {},
) {
  const ledger = { settled: [], requests: [], ...options.ledger };
  return policySignals(request, { ...DEFAULT_POLICY, ...policy }, ledger, NOW, options.known ?? true).map((signal) => signal.code);
}

describe("policySignals", () => {
  it("stays silent on a normal payment to a known payee", () => {
    expect(codes()).toEqual([]);
  });

  it("freezing blocks everything", () => {
    expect(codes(makeRequest(), { frozen: true })).toEqual(["POLICY_FROZEN"]);
  });

  it("refuses an asset that isn't allowed", () => {
    expect(codes(makeRequest({ asset: "nep141:scamcoin.near" }))).toEqual(["POLICY_ASSET_NOT_ALLOWED"]);
  });

  it("refuses native NEAR, because plain near has no alias to wNEAR", () => {
    expect(codes(makeRequest({ asset: normalizeAsset("near") }))).toEqual(["POLICY_ASSET_NOT_ALLOWED"]);
  });

  it.each([
    ["5", false],
    ["5.000001", true],
  ])("per-payment limit at %s: over the limit = %s", (amount, over) => {
    expect(codes(makeRequest({ amount })).includes("POLICY_OVER_PER_PAYMENT_LIMIT")).toBe(over);
  });

  it.each([
    ["3", false],
    ["3.01", true],
  ])("approval threshold at %s: owner asked = %s", (amount, asked) => {
    expect(codes(makeRequest({ amount })).includes("POLICY_ABOVE_APPROVAL_THRESHOLD")).toBe(asked);
  });

  it("asks about a new payee when the owner wants that", () => {
    expect(codes(makeRequest(), {}, { known: false })).toEqual(["POLICY_NEW_PAYEE_REQUIRES_APPROVAL"]);
  });

  it("doesn't ask when the owner turned that off", () => {
    expect(codes(makeRequest(), { askForNewPayees: false }, { known: false })).toEqual([]);
  });

  describe("daily budget", () => {
    const spent = (amount: string, minutes = 60) => makeSettled({ amount, settledAt: minutesAgo(minutes) });

    it("counts what already settled today", () => {
      const settled = [spent("20"), spent("18")];
      expect(codes(makeRequest({ amount: "2" }), {}, { ledger: { settled } })).toEqual([]);
      expect(codes(makeRequest({ amount: "2.01" }), {}, { ledger: { settled } })).toContain("POLICY_OVER_DAILY_BUDGET");
    });

    it("forgets spending older than 24 hours", () => {
      expect(codes(makeRequest({ amount: "2" }), {}, { ledger: { settled: [spent("40", 25 * 60)] } })).toEqual([]);
    });

    it("counts each asset on its own", () => {
      const settled = [makeSettled({ asset: USDC_ASSET, amount: "40", settledAt: minutesAgo(60) })];
      expect(codes(makeRequest({ asset: WNEAR_ASSET }), {}, { ledger: { settled } })).toEqual([]);
    });

    it("adds up small amounts without float errors", () => {
      const settled = [spent("0.1"), spent("0.2")];
      expect(codes(makeRequest({ amount: "0.3" }), { dailyBudget: "0.6" }, { ledger: { settled } })).toEqual([]);
    });
  });

  it("the forced ones decide on their own, whatever the score", () => {
    for (const change of [{ frozen: true }, { maxPerPayment: "1" }, { dailyBudget: "1" }, { allowedAssets: ["other"] }]) {
      const signals = policySignals(makeRequest(), { ...DEFAULT_POLICY, ...change }, { settled: [], requests: [] }, NOW, true);
      expect(decide(signals)).toMatchObject({ decision: "BLOCK", rule: 1 });
    }
  });
});

describe("OwnerPolicySchema", () => {
  it("accepts the default policy", () => {
    expect(OwnerPolicySchema.parse(DEFAULT_POLICY)).toEqual(DEFAULT_POLICY);
  });

  it("refuses any policy that turns native NEAR transfers on", () => {
    expect(() => OwnerPolicySchema.parse({ ...DEFAULT_POLICY, nativeNearTransfers: true })).toThrow();
  });

  it("refuses a nonsense limit", () => {
    expect(() => OwnerPolicySchema.parse({ ...DEFAULT_POLICY, maxPerPayment: "lots" })).toThrow();
    expect(() => OwnerPolicySchema.parse({ ...DEFAULT_POLICY, maxPerPayment: "0" })).toThrow();
  });

  it("refuses an empty asset list and unknown fields", () => {
    expect(() => OwnerPolicySchema.parse({ ...DEFAULT_POLICY, allowedAssets: [] })).toThrow();
    expect(() => OwnerPolicySchema.parse({ ...DEFAULT_POLICY, surprise: true })).toThrow();
  });
});

describe("normalizeAsset", () => {
  it.each([
    ["wNEAR", WNEAR_ASSET],
    ["wrap.near", WNEAR_ASSET],
    [WNEAR_ASSET, WNEAR_ASSET],
    ["USDC", USDC_ASSET],
    [USDC_ASSET, USDC_ASSET],
    ["near", "near"],
    ["nep141:other.near", "nep141:other.near"],
  ])("%s becomes %s", (input, expected) => {
    expect(normalizeAsset(input)).toBe(expected);
  });
});
