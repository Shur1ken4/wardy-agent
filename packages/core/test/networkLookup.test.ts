import { describe, expect, it } from "vitest";
import type { KnownPayee } from "../src/ledger.js";
import { isValidReport, networkSignals, type ReportRules } from "../src/network/lookup.js";
import type { NetworkReport } from "../src/types.js";

const REPORTER = "trusted-reporter-key";
const PAYEE = { payee: "acme-sh0p.near", chain: "near" };

const rules: ReportRules = {
  trustedReporters: new Set([REPORTER]),
  verifyEvidence: (report) => report.evidence.verdictSignature === "good-signature",
  allowSeedReports: false,
};

function report(overrides: Partial<NetworkReport> = {}, evidence: Partial<NetworkReport["evidence"]> = {}): NetworkReport {
  return {
    reportId: crypto.randomUUID(),
    payee: PAYEE.payee,
    chain: PAYEE.chain,
    codes: ["LOOKALIKE_HOMOGLYPH"],
    evidence: {
      verdictId: "verdict-1",
      verdictSignature: "good-signature",
      requestHash: "a".repeat(64),
      lookalikeOf: "acme-shop.near",
      ...evidence,
    },
    reporter: REPORTER,
    createdAt: "2026-11-05T12:00:00.000Z",
    merkleLeaf: "b".repeat(64),
    reportSignature: "not-checked-by-these-tests",
    ...overrides,
  };
}

async function codes(reports: NetworkReport[], known: KnownPayee[] = [], ruleset = rules) {
  return (await networkSignals(PAYEE, reports, known, ruleset)).map((signal) => signal.code);
}

describe("networkSignals", () => {
  it("one valid report is enough, and it's critical", async () => {
    const [signal] = await networkSignals(PAYEE, [report()], [], rules);
    expect(signal).toMatchObject({ code: "NETWORK_REPORTED_SCAM", severity: "critical", points: 80 });
  });

  it("shows the evidence it relied on", async () => {
    const valid = report();
    const [signal] = await networkSignals(PAYEE, [valid], [], rules);
    expect(signal?.evidence).toMatchObject({ reportId: valid.reportId, verdictId: "verdict-1", codes: ["LOOKALIKE_HOMOGLYPH"] });
  });

  it("no reports means no signal", async () => {
    expect(await codes([])).toEqual([]);
  });

  it("adds +10 when the report says it imitates a payee this owner paid", async () => {
    const known = [{ accountId: "acme-shop.near", chain: "near", paidCount: 3 }];
    const signals = await networkSignals(PAYEE, [report()], known, rules);
    expect(signals.map((signal) => signal.code)).toEqual(["NETWORK_REPORTED_SCAM", "NETWORK_REPORTED_LOOKALIKE_OF_YOUR_PAYEE"]);
    expect(signals[1]).toMatchObject({ severity: "critical", points: 10 });
  });

  it("doesn't add that for someone else's payee", async () => {
    const known = [{ accountId: "unrelated.near", chain: "near", paidCount: 3 }];
    expect(await codes([report()], known)).toEqual(["NETWORK_REPORTED_SCAM"]);
  });

  it("ignores a report about a different payee or chain", async () => {
    expect(await codes([report({ payee: "other.near" })])).toEqual([]);
    expect(await codes([report({ chain: "base" })])).toEqual([]);
  });
});

// Votes can be manufactured. Every rule below is why a pile-on can't get an innocent payee blocked.
describe("anti-poisoning", () => {
  it("a thousand fake reports weigh exactly as much as none", async () => {
    const pileOn = Array.from({ length: 1000 }, () => report({ reporter: "sybil-key" }));
    expect(await codes(pileOn)).toEqual([]);
  });

  it("many reports don't score higher than one: nothing counts", async () => {
    const one = await networkSignals(PAYEE, [report()], [], rules);
    const many = await networkSignals(PAYEE, Array.from({ length: 50 }, () => report()), [], rules);
    expect(many.map((signal) => signal.points)).toEqual(one.map((signal) => signal.points));
  });

  it("rejects an untrusted reporter", async () => {
    expect(await isValidReport(report({ reporter: "stranger" }), rules)).toBe(false);
  });

  it("rejects a verdict signature that doesn't verify", async () => {
    expect(await isValidReport(report({}, { verdictSignature: "forged" }), rules)).toBe(false);
  });

  it.each(["verdictId", "verdictSignature", "requestHash"] as const)("rejects a report missing %s", async (field) => {
    expect(await isValidReport(report({}, { [field]: "" }), rules)).toBe(false);
  });

  it("rejects a report with no evidence object at all", async () => {
    expect(await isValidReport({ ...report(), evidence: undefined } as unknown as NetworkReport, rules)).toBe(false);
  });

  it("a revoked report no longer counts", async () => {
    expect(await codes([report({ revokedAt: "2026-11-05T13:00:00.000Z" })])).toEqual([]);
  });

  it("seed fixtures never count in live decisions", async () => {
    expect(await codes([report({ seed: true })])).toEqual([]);
  });

  it("seed fixtures count only where offline demos allow them", async () => {
    expect(await codes([report({ seed: true })], [], { ...rules, allowSeedReports: true })).toEqual(["NETWORK_REPORTED_SCAM"]);
  });

  it("a verifier that throws means invalid, not a crash", async () => {
    const throwing = { ...rules, verifyEvidence: () => { throw new Error("boom"); } };
    expect(await isValidReport(report(), throwing)).toBe(false);
  });

  it("one bad report doesn't hide a good one", async () => {
    expect(await codes([report({ reporter: "stranger" }), report()])).toEqual(["NETWORK_REPORTED_SCAM"]);
  });
});
