import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeSignal, type SignalCode } from "../src/config.js";
import { isValidReport, networkSignals, type ReportRules } from "../src/network/lookup.js";
import { createNetworkReport, evidenceFamilies, reportLeaf, shouldPublishReport, verifyReportEvidence } from "../src/network/report.js";
import { publishIfWarranted, ReportStore } from "../src/network/store.js";
import { generateSigningKey, publicKeyOf, signText, signVerdict } from "../src/sign.js";
import type { NetworkReport, Verdict } from "../src/types.js";
import { makeUnsignedVerdict, NOW } from "./helpers.js";

const KEY = generateSigningKey();
const AT = NOW.toISOString();
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function blocked(codes: SignalCode[], overrides: Partial<Verdict> = {}, key = KEY) {
  const signals = codes.map((code) =>
    makeSignal(code, code, code.startsWith("LOOKALIKE") ? { lookalikeOf: "acme-shop.near" } : {}),
  );
  return signVerdict(makeUnsignedVerdict({ decision: "BLOCK", payee: "acme-sh0p.near", signals, ...overrides }), key);
}

async function report(codes: SignalCode[] = ["LOOKALIKE_HOMOGLYPH", "ACCOUNT_VERY_NEW"]): Promise<NetworkReport> {
  return createNetworkReport(await blocked(codes), { signingKey: KEY, createdAt: AT });
}

/** What an attacker with no key can do: recalculate the hash after changing a field. */
function rehashed(tampered: NetworkReport): NetworkReport {
  const { merkleLeaf: _leaf, reportSignature: _signature, revokedAt: _revoked, ...fields } = tampered;
  return { ...tampered, merkleLeaf: reportLeaf(fields) };
}

/** What a buggy or dishonest reporter could do, holding the real key: sign whatever it likes. */
async function resigned(tampered: NetworkReport, key = KEY): Promise<NetworkReport> {
  const sealed = rehashed(tampered);
  return { ...sealed, reportSignature: await signText(sealed.merkleLeaf, key) };
}

describe("shouldPublishReport", () => {
  it.each<[string, SignalCode[]]>([
    ["a lookalike on a brand-new account (A1, A5)", ["LOOKALIKE_HOMOGLYPH", "ACCOUNT_VERY_NEW"]],
    ["a lookalike with a payee change", ["LOOKALIKE_SUFFIX_TRICK", "CONTEXT_PAYEE_CHANGE"]],
    ["a bypass attempt from a brand-new account (A3, A8)", ["CONTEXT_BYPASS_ATTEMPT", "ACCOUNT_VERY_NEW"]],
    ["split payments to a brand-new account (A9)", ["VELOCITY_NEW_PAYEE", "ACCOUNT_VERY_NEW"]],
    ["a lookalike that doesn't exist yet", ["LOOKALIKE_EDIT_DISTANCE", "ACCOUNT_NOT_FOUND"]],
  ])("publishes %s", async (_name, codes) => {
    expect(shouldPublishReport(await blocked(codes))).toBe(true);
  });

  // One suspicion stays local: a report blocks this payee for every agent.
  it.each<[string, SignalCode[]]>([
    ["a lookalike alone: the name could be innocent", ["LOOKALIKE_HOMOGLYPH"]],
    ["two signals of one family", ["LOOKALIKE_HOMOGLYPH", "LOOKALIKE_SUFFIX_TRICK"]],
    ["suspicious text alone", ["CONTEXT_BYPASS_ATTEMPT", "CONTEXT_PAYEE_CHANGE"]],
    ["a wrong address format (A6): likely a mistake", ["CHAIN_ADDRESS_MISMATCH"]],
    ["a broken limit, which says nothing about the payee", ["POLICY_OVER_PER_PAYMENT_LIMIT", "CONTEXT_PAYEE_CHANGE"]],
    ["a merely young account, with a payee change", ["ACCOUNT_NEW", "CONTEXT_PAYEE_CHANGE"]],
    ["urgency, which isn't evidence", ["CONTEXT_URGENCY", "ACCOUNT_VERY_NEW"]],
    ["a network report alone: no amplifying our own feed", ["NETWORK_REPORTED_SCAM", "NETWORK_REPORTED_LOOKALIKE_OF_YOUR_PAYEE"]],
  ])("doesn't publish %s", async (_name, codes) => {
    expect(shouldPublishReport(await blocked(codes))).toBe(false);
  });

  it("never reports a payee the owner has really paid: a tampered invoice attacks the merchant too (A4)", async () => {
    expect(shouldPublishReport(await blocked(["KNOWN_PAYEE", "CONTEXT_BYPASS_ATTEMPT", "VELOCITY_NEW_PAYEE"]))).toBe(false);
  });

  it("never publishes from a HOLD or an ALLOW", async () => {
    const codes: SignalCode[] = ["LOOKALIKE_HOMOGLYPH", "ACCOUNT_VERY_NEW"];
    expect(shouldPublishReport(await blocked(codes, { decision: "HOLD" }))).toBe(false);
    expect(shouldPublishReport(await blocked(codes, { decision: "ALLOW" }))).toBe(false);
  });

  it("never publishes from a check: anyone can send a check, so anyone could smear a payee", async () => {
    expect(shouldPublishReport(await blocked(["LOOKALIKE_HOMOGLYPH", "ACCOUNT_VERY_NEW"], { mode: "check" }))).toBe(false);
  });

  it("names the families it counted", async () => {
    expect(evidenceFamilies(await blocked(["LOOKALIKE_HOMOGLYPH", "ACCOUNT_VERY_NEW", "CONTEXT_URGENCY"])).sort()).toEqual(["lookalike", "new_account"]);
  });
});

describe("createNetworkReport", () => {
  it("carries the evidence, and says what it imitates", async () => {
    const verdict = await blocked(["LOOKALIKE_HOMOGLYPH", "ACCOUNT_VERY_NEW"]);
    const created = await createNetworkReport(verdict, { signingKey: KEY, createdAt: AT });
    expect(created).toMatchObject({
      payee: "acme-sh0p.near",
      chain: "near",
      codes: ["LOOKALIKE_HOMOGLYPH", "ACCOUNT_VERY_NEW"],
      reporter: await publicKeyOf(KEY),
      createdAt: AT,
      evidence: { verdictId: verdict.verdictId, verdictSignature: verdict.signature, requestHash: verdict.requestHash, lookalikeOf: "acme-shop.near" },
    });
  });

  it("leaves limits out of the reasons: they're the owner's business, not evidence", async () => {
    expect((await report(["LOOKALIKE_HOMOGLYPH", "POLICY_OVER_PER_PAYMENT_LIMIT"])).codes).toEqual(["LOOKALIKE_HOMOGLYPH"]);
  });

  it("leaves out what changes after the decision", async () => {
    const verdict = await blocked(["LOOKALIKE_HOMOGLYPH", "ACCOUNT_VERY_NEW"], { execution: { status: "refused", provider: "mock" }, networkReportId: "x" });
    const { signedVerdict } = (await createNetworkReport(verdict, { signingKey: KEY, createdAt: AT })).evidence;
    expect(signedVerdict).not.toHaveProperty("execution");
    expect(signedVerdict).not.toHaveProperty("networkReportId");
  });

  it("marks seed data as seed", async () => {
    const created = await createNetworkReport(await blocked(["LOOKALIKE_HOMOGLYPH", "ACCOUNT_VERY_NEW"]), { signingKey: KEY, createdAt: AT, seed: true });
    expect(created.seed).toBe(true);
    expect(await verifyReportEvidence(created)).toBe(true);
  });

  it("a leaf commits to the report: change a field, and the leaf changes", async () => {
    const created = await report();
    const { merkleLeaf: _leaf, reportSignature: _signature, ...withoutLeaf } = created;
    expect(reportLeaf(withoutLeaf)).toBe(created.merkleLeaf);
    expect(reportLeaf({ ...withoutLeaf, payee: "other.near" })).not.toBe(created.merkleLeaf);
  });
});

describe("verifyReportEvidence: anyone can check a report using only the report", () => {
  it("accepts a real report, including after a trip through JSON", async () => {
    const created = await report();
    expect(await verifyReportEvidence(created)).toBe(true);
    expect(await verifyReportEvidence(JSON.parse(JSON.stringify(created)))).toBe(true);
  });

  it("accepts a revoked report's evidence: revoking isn't rewriting", async () => {
    expect(await verifyReportEvidence({ ...(await report()), revokedAt: AT })).toBe(true);
  });

  it.each<[string, (created: NetworkReport) => NetworkReport]>([
    ["a report about someone else, reusing real evidence", (created) => ({ ...created, payee: "innocent.near" })],
    ["another chain", (created) => ({ ...created, chain: "base" })],
    ["a different reporter", (created) => ({ ...created, reporter: "0".repeat(64) })],
    ["added reasons", (created) => ({ ...created, codes: [...created.codes, "NETWORK_REPORTED_SCAM"] })],
    ["a swapped signature", (created) => ({ ...created, evidence: { ...created.evidence, verdictSignature: "ab".repeat(64) } })],
    ["a swapped verdict id", (created) => ({ ...created, evidence: { ...created.evidence, verdictId: "other" } })],
    ["a swapped request hash", (created) => ({ ...created, evidence: { ...created.evidence, requestHash: "c".repeat(64) } })],
    ["a changed target of imitation", (created) => ({ ...created, evidence: { ...created.evidence, lookalikeOf: "someone-else.near" } })],
    ["a forged verdict inside", (created) => ({ ...created, evidence: { ...created.evidence, signedVerdict: { ...created.evidence.signedVerdict!, riskScore: 1 } } })],
    ["no verdict at all", (created) => {
      const { signedVerdict: _gone, ...evidence } = created.evidence;
      return { ...created, evidence };
    }],
  ])("rejects %s", async (_name, tamper) => {
    expect(await verifyReportEvidence(tamper(await report()))).toBe(false);
  });

  // The signature is what stops these: recalculating the hash is free, so it can't be what's trusted.
  it.each<[string, (created: NetworkReport) => NetworkReport]>([
    ["a report about someone else", (created) => ({ ...created, payee: "innocent.near" })],
    ["added reasons", (created) => ({ ...created, codes: [...created.codes, "NETWORK_REPORTED_SCAM"] })],
    ["a changed target of imitation", (created) => ({ ...created, evidence: { ...created.evidence, lookalikeOf: "someone-else.near" } })],
    ["a seed flag added", (created) => ({ ...created, seed: true })],
    ["a changed date", (created) => ({ ...created, createdAt: "2020-01-01T00:00:00.000Z" })],
    ["a changed id", (created) => ({ ...created, reportId: "other" })],
    ["a forged verdict inside", (created) => ({ ...created, evidence: { ...created.evidence, signedVerdict: { ...created.evidence.signedVerdict!, riskScore: 1 } } })],
  ])("rejects %s, even with its hash recalculated", async (_name, tamper) => {
    expect(await verifyReportEvidence(rehashed(tamper(await report())))).toBe(false);
  });

  it("rejects a seed flag stripped from a seed report", async () => {
    const seeded = await createNetworkReport(await blocked(["LOOKALIKE_HOMOGLYPH", "ACCOUNT_VERY_NEW"]), { signingKey: KEY, createdAt: AT, seed: true });
    const { seed: _seed, ...stripped } = seeded;
    expect(await verifyReportEvidence(rehashed(stripped))).toBe(false);
  });

  // The evidence checks stop these: even a signature from the real key can't make the evidence say something else.
  it.each<[string, (created: NetworkReport) => NetworkReport]>([
    ["real evidence about one payee on a report about another", (created) => ({ ...created, payee: "innocent.near" })],
    ["another chain", (created) => ({ ...created, chain: "base" })],
    ["a swapped signature", (created) => ({ ...created, evidence: { ...created.evidence, verdictSignature: "ab".repeat(64) } })],
    ["a swapped verdict id", (created) => ({ ...created, evidence: { ...created.evidence, verdictId: "other" } })],
    ["a swapped request hash", (created) => ({ ...created, evidence: { ...created.evidence, requestHash: "c".repeat(64) } })],
    ["a verdict changed after signing", (created) => ({ ...created, evidence: { ...created.evidence, signedVerdict: { ...created.evidence.signedVerdict!, riskScore: 1 } } })],
  ])("rejects %s, even signed by the real reporter", async (_name, tamper) => {
    expect(await verifyReportEvidence(await resigned(tamper(await report())))).toBe(false);
  });

  it("rejects a report signed by someone other than its named reporter", async () => {
    expect(await verifyReportEvidence(await resigned(await report(), generateSigningKey()))).toBe(false);
  });

  it("rejects a garbage signature without throwing", async () => {
    expect(await verifyReportEvidence({ ...(await report()), reportSignature: "zz" })).toBe(false);
    expect(await verifyReportEvidence({ ...(await report()), reportSignature: "" })).toBe(false);
  });

  it("rejects a report built on an ALLOW", async () => {
    const allowed = await blocked(["LOOKALIKE_HOMOGLYPH", "ACCOUNT_VERY_NEW"], { decision: "ALLOW" });
    expect(await verifyReportEvidence(await createNetworkReport(allowed, { signingKey: KEY, createdAt: AT }))).toBe(false);
  });

  it("an attacker's own well-formed report verifies, so the trusted-reporter check is what stops it", async () => {
    const attackerKey = generateSigningKey();
    const forged = await createNetworkReport(await blocked(["LOOKALIKE_HOMOGLYPH", "ACCOUNT_VERY_NEW"], { payee: "innocent.near" }, attackerKey), { signingKey: attackerKey, createdAt: AT });
    expect(await verifyReportEvidence(forged)).toBe(true);
    const rules: ReportRules = { trustedReporters: new Set([await publicKeyOf(KEY)]), verifyEvidence: verifyReportEvidence, allowSeedReports: false };
    expect(await isValidReport(forged, rules)).toBe(false);
    expect(await networkSignals({ payee: "innocent.near", chain: "near" }, [forged], [], rules)).toEqual([]);
  });

  it("a real report from a trusted reporter becomes a signal", async () => {
    const rules: ReportRules = { trustedReporters: new Set([await publicKeyOf(KEY)]), verifyEvidence: verifyReportEvidence, allowSeedReports: false };
    const [signal] = await networkSignals({ payee: "acme-sh0p.near", chain: "near" }, [await report()], [], rules);
    expect(signal?.code).toBe("NETWORK_REPORTED_SCAM");
  });

  it("the report holds no context text, because verdicts hold none", async () => {
    expect(JSON.stringify(await report())).not.toContain("invoiceText");
  });
});

describe("ReportStore", () => {
  it("finds reports by payee and chain, most recent first", async () => {
    const store = new ReportStore();
    const first = await report();
    const second = await createNetworkReport(await blocked(["LOOKALIKE_HOMOGLYPH", "ACCOUNT_VERY_NEW"], { payee: "other.near" }), { signingKey: KEY, createdAt: AT });
    store.add(first);
    store.add(second);
    expect(store.reportsFor("acme-sh0p.near", "near").map((item) => item.reportId)).toEqual([first.reportId]);
    expect(store.reportsFor("acme-sh0p.near", "base")).toEqual([]);
    expect(store.recent(1).map((item) => item.reportId)).toEqual([second.reportId]);
  });

  it("keeps everything across a restart, including revocations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wardy-agent-reports-"));
    dirs.push(dir);
    const path = join(dir, "network", "reports.jsonl");
    const created = await report();
    const store = new ReportStore(path);
    store.add(created);
    expect(store.revoke(created.reportId, AT)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2); // A revocation is a new line, not a rewrite.
    expect(new ReportStore(path).all()[0]?.revokedAt).toBe(AT);
  });

  it("can't revoke what isn't there", () => {
    expect(new ReportStore().revoke("nope", AT)).toBe(false);
  });

  it("a revoked report stops counting at once", async () => {
    const store = new ReportStore();
    const created = await report();
    store.add(created);
    const rules: ReportRules = { trustedReporters: new Set([created.reporter]), verifyEvidence: verifyReportEvidence, allowSeedReports: false };
    expect(await networkSignals({ payee: "acme-sh0p.near", chain: "near" }, store.all(), [], rules)).toHaveLength(1);
    store.revoke(created.reportId, AT);
    expect(await networkSignals({ payee: "acme-sh0p.near", chain: "near" }, store.all(), [], rules)).toEqual([]);
  });
});

describe("publishIfWarranted", () => {
  const codes: SignalCode[] = ["LOOKALIKE_HOMOGLYPH", "ACCOUNT_VERY_NEW"];

  it("publishes once, and returns the id", async () => {
    const store = new ReportStore();
    const id = await publishIfWarranted(store, await blocked(codes), { signingKey: KEY, createdAt: AT });
    expect(id).toBe(store.all()[0]?.reportId);
  });

  it("doesn't pad the feed with repeats about one payee", async () => {
    const store = new ReportStore();
    await publishIfWarranted(store, await blocked(codes), { signingKey: KEY, createdAt: AT });
    expect(await publishIfWarranted(store, await blocked(codes), { signingKey: KEY, createdAt: AT })).toBeUndefined();
    expect(store.all()).toHaveLength(1);
  });

  it("can report again after a revocation", async () => {
    const store = new ReportStore();
    const id = (await publishIfWarranted(store, await blocked(codes), { signingKey: KEY, createdAt: AT })) as string;
    store.revoke(id, AT);
    expect(await publishIfWarranted(store, await blocked(codes), { signingKey: KEY, createdAt: AT })).toBeDefined();
  });

  it("publishes nothing when one suspicion is all there is", async () => {
    const store = new ReportStore();
    expect(await publishIfWarranted(store, await blocked(["LOOKALIKE_HOMOGLYPH"]), { signingKey: KEY, createdAt: AT })).toBeUndefined();
    expect(store.all()).toEqual([]);
  });
});
