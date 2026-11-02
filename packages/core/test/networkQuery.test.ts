// The Wardy Network's anti-poisoning rules, tested through the same lookup an agent uses. Everything here is a report
// someone could really put in a feed.
import { describe, expect, it } from "vitest";
import { makeSignal, type SignalCode } from "../src/config.js";
import { AnchorRecordSchema, type AnchorRecord } from "../src/network/anchor.js";
import type { ReportRules } from "../src/network/lookup.js";
import { merkleRoot, verifyMerkleProof } from "../src/network/merkle.js";
import { NetworkQuery } from "../src/network/query.js";
import { createNetworkReport, revocationLeaf, verifyReportEvidence, verifyRevocation, whyOwnerCantReport } from "../src/network/report.js";
import { appendToFeed, feedLineLeaf, parseFeed, ReportStore, serializeFeed } from "../src/network/store.js";
import { generateSigningKey, publicKeyOf, publicVerdictOf, signText, signVerdict, verifyPublicVerdict, verifyVerdict } from "../src/sign.js";
import type { NetworkReport, Verdict } from "../src/types.js";
import { makeUnsignedVerdict, NOW } from "./helpers.js";

const KEY = generateSigningKey();
const AT = NOW.toISOString();
const PAYEE = "acme-sh0p.near";
const CODES: SignalCode[] = ["LOOKALIKE_HOMOGLYPH", "ACCOUNT_VERY_NEW"];

function blocked(overrides: Partial<Verdict> = {}, key = KEY, codes = CODES) {
  const signals = codes.map((code) => makeSignal(code, `Secret message about ${code}, a payee you paid 3 times.`, code.startsWith("LOOKALIKE") ? { lookalikeOf: "acme-shop.near", paidCount: 3 } : {}));
  return signVerdict(makeUnsignedVerdict({ decision: "BLOCK", payee: PAYEE, amount: "1234.5678", signals, reasons: ["You paid this supplier 3 times."], ...overrides }), key);
}

async function reportFrom(key = KEY, overrides: Partial<Verdict> = {}, seed = false) {
  return createNetworkReport(await blocked(overrides, key), { signingKey: key, createdAt: AT, ...(seed ? { seed: true } : {}) });
}

async function rulesFor(key = KEY, allowSeedReports = false): Promise<ReportRules> {
  return { trustedReporters: new Set([await publicKeyOf(key)]), verifyEvidence: verifyReportEvidence, allowSeedReports };
}

function anchorOver(leaves: string[]): AnchorRecord {
  return {
    network: "testnet",
    contractId: "registry.testnet",
    reporter: "reporter.testnet",
    root: merkleRoot(leaves),
    count: leaves.length,
    uri: "test feed",
    txHash: "TX",
    txUrl: "https://testnet.near.rocks/tx/TX",
    blockHeight: "1",
    anchoredAt: AT,
    leaves,
  };
}

async function queryOver(reports: NetworkReport[], options: { anchorLeaves?: string[]; rules?: ReportRules } = {}) {
  const store = new ReportStore();
  for (const report of reports) store.add(report);
  const rules = options.rules ?? (await rulesFor());
  return { store, query: new NetworkQuery(store, rules, () => (options.anchorLeaves ? anchorOver(options.anchorLeaves) : null)) };
}

describe("what a public report reveals", () => {
  it("proves the verdict's signature without its amount or the owner's history", async () => {
    const verdict = await blocked();
    const part = publicVerdictOf(verdict);
    expect(await verifyPublicVerdict(part, await publicKeyOf(KEY))).toBe(true);
    expect(part.signature).toBe(verdict.signature);
    for (const key of ["amount", "asset", "signals", "reasons", "requestId", "ai"]) expect(part).not.toHaveProperty(key);
  });

  it("a full report has none of the private values, anywhere", async () => {
    const text = JSON.stringify(await reportFrom());
    for (const secret of ["1234.5678", "paid 3 times", "paidCount", "Secret message", "reasons", "invoiceText"]) expect(text).not.toContain(secret);
  });

  it("the signature still commits to the hidden part: change any of it, and the full verdict stops verifying", async () => {
    const verdict = await blocked();
    expect(await verifyVerdict(verdict)).toBe(true);
    for (const changed of [{ amount: "1" }, { asset: "other" }, { requestId: crypto.randomUUID() }, { reasons: [] }, { signals: [] }]) {
      expect(await verifyVerdict({ ...verdict, ...changed }), JSON.stringify(changed)).toBe(false);
    }
  });

  it("a report can't be opened up to show a different amount than was signed", async () => {
    const verdict = await blocked();
    const part = publicVerdictOf(verdict);
    const lied = publicVerdictOf({ ...verdict, amount: "1" });
    expect(lied.privateHash).not.toBe(part.privateHash);
    expect(await verifyPublicVerdict(lied)).toBe(false);
  });

  it.each<[string, (part: ReturnType<typeof publicVerdictOf>) => object]>([
    ["a changed decision", (part) => ({ ...part, decision: "ALLOW" })],
    ["a changed payee", (part) => ({ ...part, payee: "innocent.near" })],
    ["a changed score", (part) => ({ ...part, riskScore: 1 })],
    ["added codes", (part) => ({ ...part, codes: [...part.codes, "NETWORK_REPORTED_SCAM"] })],
    ["a changed target", (part) => ({ ...part, lookalikeOf: "someone-else.near" })],
    ["a changed private hash", (part) => ({ ...part, privateHash: "0".repeat(64) })],
    ["an added field", (part) => ({ ...part, note: "trust me" })],
  ])("rejects a public verdict with %s", async (_name, tamper) => {
    expect(await verifyPublicVerdict(tamper(publicVerdictOf(await blocked())) as ReturnType<typeof publicVerdictOf>)).toBe(false);
  });

  it("policy limits stay out of the public codes", async () => {
    const verdict = await blocked({}, KEY, ["LOOKALIKE_HOMOGLYPH", "ACCOUNT_VERY_NEW", "POLICY_OVER_PER_PAYMENT_LIMIT"]);
    expect(publicVerdictOf(verdict).codes).toEqual(CODES);
  });
});

describe("rules anyone can check on a report, even one signed by a real reporter", () => {
  const signed = (verdict: Verdict) => createNetworkReport(verdict, { signingKey: KEY, createdAt: AT });

  it("one kind of evidence isn't enough", async () => {
    expect(await verifyReportEvidence(await signed(await blocked({}, KEY, ["LOOKALIKE_HOMOGLYPH"])))).toBe(false);
  });

  it("a payee the owner has really paid can't be reported", async () => {
    expect(await verifyReportEvidence(await signed(await blocked({}, KEY, [...CODES, "KNOWN_PAYEE"])))).toBe(false);
  });

  it("a held payment can't become a report unless the owner confirmed it", async () => {
    expect(await verifyReportEvidence(await signed(await blocked({ decision: "HOLD" })))).toBe(false);
  });

  it("a check can't become a report: anyone can send a check", async () => {
    expect(await verifyReportEvidence(await signed(await blocked({ mode: "check" })))).toBe(false);
  });

  it("the report's reasons must be the verdict's", async () => {
    const real = await signed(await blocked());
    const { merkleLeaf: _leaf, reportSignature: _signature, ...fields } = real;
    const { reportLeaf } = await import("../src/network/report.js");
    const claims = { ...fields, codes: ["NETWORK_REPORTED_SCAM", "CONTEXT_BYPASS_ATTEMPT", "LOOKALIKE_HOMOGLYPH"] };
    const merkleLeaf = reportLeaf(claims);
    expect(await verifyReportEvidence({ ...claims, merkleLeaf, reportSignature: await signText(merkleLeaf, KEY) })).toBe(false);
  });
});

describe("a report the owner confirmed", () => {
  const confirmed = (verdict: Verdict) => createNetworkReport(verdict, { signingKey: KEY, createdAt: AT, ownerConfirmed: true });

  it("can rest on one kind of evidence, or on a held payment, and it says so", async () => {
    const one = await confirmed(await blocked({}, KEY, ["LOOKALIKE_HOMOGLYPH"]));
    expect(one.ownerConfirmed).toBe(true);
    expect(await verifyReportEvidence(one)).toBe(true);
    expect(await verifyReportEvidence(await confirmed(await blocked({ decision: "HOLD" }, KEY, ["ACCOUNT_VERY_NEW"])))).toBe(true);
  });

  it("still needs some evidence about the payee", async () => {
    expect(await verifyReportEvidence(await confirmed(await blocked({}, KEY, ["POLICY_OVER_PER_PAYMENT_LIMIT"])))).toBe(false);
  });

  it("still can't be about a payee the owner has really paid", async () => {
    expect(await verifyReportEvidence(await confirmed(await blocked({}, KEY, ["ACCOUNT_VERY_NEW", "KNOWN_PAYEE"])))).toBe(false);
  });

  it("still can't come from an ALLOW or a check", async () => {
    expect(await verifyReportEvidence(await confirmed(await blocked({ decision: "ALLOW" }, KEY, ["ACCOUNT_VERY_NEW"])))).toBe(false);
    expect(await verifyReportEvidence(await confirmed(await blocked({ mode: "check" }, KEY, ["ACCOUNT_VERY_NEW"])))).toBe(false);
  });

  it("the label can't be added later: a thin report can't claim the owner's word", async () => {
    const thin = await createNetworkReport(await blocked({}, KEY, ["LOOKALIKE_HOMOGLYPH"]), { signingKey: KEY, createdAt: AT });
    expect(await verifyReportEvidence(thin)).toBe(false);
    expect(await verifyReportEvidence({ ...thin, ownerConfirmed: true })).toBe(false);
  });

  it("the label can't be stripped either", async () => {
    const { ownerConfirmed: _gone, ...stripped } = await confirmed(await blocked());
    expect(await verifyReportEvidence(stripped)).toBe(false);
  });

  it("a normal report's leaf doesn't change, so what's already anchored stays valid", async () => {
    const plain = await reportFrom();
    expect(plain).not.toHaveProperty("ownerConfirmed");
    expect(await verifyReportEvidence(plain)).toBe(true);
  });
});

describe("whyOwnerCantReport", () => {
  it.each<[string, Partial<Verdict>, SignalCode[], string | null]>([
    ["a BLOCK with evidence", {}, ["ACCOUNT_VERY_NEW"], null],
    ["a rejected HOLD", { decision: "HOLD", execution: { status: "refused", provider: "mock" } }, ["ACCOUNT_VERY_NEW"], null],
    ["a HOLD still waiting", { decision: "HOLD", execution: { status: "pending_owner", provider: "mock" } }, ["ACCOUNT_VERY_NEW"], "rejected"],
    ["an ALLOW", { decision: "ALLOW" }, ["ACCOUNT_VERY_NEW"], "blocked"],
    ["a check", { mode: "check" }, ["ACCOUNT_VERY_NEW"], "question"],
    ["a known payee", {}, ["ACCOUNT_VERY_NEW", "KNOWN_PAYEE"], "really paid"],
    ["a broken limit alone", {}, ["POLICY_OVER_PER_PAYMENT_LIMIT"], "limits"],
  ])("%s", async (_name, overrides, codes, expected) => {
    const reason = whyOwnerCantReport(await blocked(overrides, KEY, codes));
    if (expected === null) expect(reason).toBeNull();
    else expect(reason).toContain(expected);
  });
});

describe("revocations", () => {
  it("a real revocation verifies, and takes the report out of lookups", async () => {
    const report = await reportFrom();
    const { store, query } = await queryOver([report]);
    expect((await query.lookup(PAYEE, "near")).reported).toBe(true);
    await store.revoke(report.reportId, AT, KEY);
    expect(await verifyRevocation(store.all()[0] as NetworkReport)).toBe(true);
    expect(await query.lookup(PAYEE, "near")).toMatchObject({ reported: false, reports: [], withdrawn: [{ reportId: report.reportId, revokedAt: AT }], merkleProof: null });
  });

  it("a revocation can't be moved to another report", async () => {
    const [first, second] = [await reportFrom(), await reportFrom(KEY, { payee: "other.near" })];
    const store = new ReportStore();
    store.add(first);
    store.add(second);
    await store.revoke(first.reportId, AT, KEY);
    const signature = store.all()[0]?.revocationSignature as string;
    expect(await verifyRevocation({ ...second, revokedAt: AT, revocationSignature: signature })).toBe(false);
  });

  it("a revocation can't be re-dated", async () => {
    const report = await reportFrom();
    const signature = await signText(revocationLeaf(report.merkleLeaf, AT), KEY);
    expect(await verifyRevocation({ ...report, revokedAt: AT, revocationSignature: signature })).toBe(true);
    expect(await verifyRevocation({ ...report, revokedAt: "2030-01-01T00:00:00.000Z", revocationSignature: signature })).toBe(false);
  });

  it("a scammer can't withdraw the report against them: forged revocations are ignored", async () => {
    const report = await reportFrom();
    const signature = await signText(revocationLeaf(report.merkleLeaf, AT), generateSigningKey());
    const { query } = await queryOver([{ ...report, revokedAt: AT, revocationSignature: signature }]);
    expect(await query.lookup(PAYEE, "near")).toMatchObject({ reported: true, withdrawn: [] });
  });

  it("a revocation is its own leaf, so an anchored root commits to it", async () => {
    const report = await reportFrom();
    const store = new ReportStore();
    store.add(report);
    const before = merkleRoot(store.lines().map(feedLineLeaf));
    await store.revoke(report.reportId, AT, KEY);
    const leaves = store.lines().map(feedLineLeaf);
    expect(leaves).toEqual([report.merkleLeaf, revocationLeaf(report.merkleLeaf, AT)]);
    expect(merkleRoot(leaves)).not.toBe(before);
  });

  it("revoking leaves the original feed line as written", async () => {
    const report = await reportFrom();
    const store = new ReportStore();
    store.add(report);
    const written = serializeFeed(store.lines());
    await store.revoke(report.reportId, AT, KEY);
    expect(serializeFeed(store.lines()).startsWith(written)).toBe(true);
  });
});

describe("the feed", () => {
  it("survives being written and read back, byte for byte", async () => {
    const store = new ReportStore();
    store.add(await reportFrom());
    store.add(await reportFrom(KEY, { payee: "other.near" }));
    await store.revoke(store.all()[0]?.reportId as string, AT, KEY);
    const text = serializeFeed(store.lines());
    expect(serializeFeed(parseFeed(text))).toBe(text);
  });

  it("appending keeps what's there, in order, and adds only what's new", async () => {
    const first = { kind: "report" as const, report: await reportFrom() };
    const second = { kind: "report" as const, report: await reportFrom(KEY, { payee: "other.near" }) };
    expect(appendToFeed([first], [first, second]).map(feedLineLeaf)).toEqual([first.report.merkleLeaf, second.report.merkleLeaf]);
    expect(appendToFeed([second], [first, second]).map(feedLineLeaf)).toEqual([second.report.merkleLeaf, first.report.merkleLeaf]);
  });

  it("merging twice adds nothing the second time", async () => {
    const source = new ReportStore();
    source.add(await reportFrom());
    const store = new ReportStore();
    expect(store.merge(source.lines())).toBe(1);
    expect(store.merge(source.lines())).toBe(0);
    expect(store.all()).toHaveLength(1);
  });
});

describe("NetworkQuery: the same rules as a payment check", () => {
  it("an anchored report comes back with a proof that verifies against the anchor", async () => {
    const report = await reportFrom();
    const other = await reportFrom(KEY, { payee: "other.near" });
    const leaves = [other.merkleLeaf, report.merkleLeaf];
    const { query } = await queryOver([report, other], { anchorLeaves: leaves });
    const answer = await query.lookup(PAYEE, "near");
    expect(answer.reported).toBe(true);
    expect(answer.merkleProof?.leaf).toBe(report.merkleLeaf);
    expect(verifyMerkleProof(answer.merkleProof as NonNullable<typeof answer.merkleProof>, { root: merkleRoot(leaves), count: 2 })).toBe(true);
    expect(answer.anchorTx).toBe("TX");
    expect(answer.anchoredRoot).toMatchObject({ root: merkleRoot(leaves), count: 2, txUrl: "https://testnet.near.rocks/tx/TX" });
    expect(answer.anchoredRoot).not.toHaveProperty("leaves");
  });

  it("a report newer than the anchor counts, and honestly has no proof yet", async () => {
    const report = await reportFrom();
    const { query } = await queryOver([report], { anchorLeaves: [(await reportFrom(KEY, { payee: "other.near" })).merkleLeaf] });
    expect(await query.lookup(PAYEE, "near")).toMatchObject({ reported: true, merkleProof: null, anchorTx: "TX" });
  });

  it("with no anchor at all, it says so", async () => {
    const { query } = await queryOver([await reportFrom()]);
    expect(await query.lookup(PAYEE, "near")).toMatchObject({ reported: true, merkleProof: null, anchoredRoot: null, anchorTx: null });
  });

  it("gives an unreported payee no proof, but still says how fresh the anchor is", async () => {
    const report = await reportFrom();
    const { query } = await queryOver([report], { anchorLeaves: [report.merkleLeaf] });
    expect(await query.lookup("unknown.near", "near")).toMatchObject({ reported: false, reports: [], merkleProof: null, anchorTx: "TX" });
  });

  it("proves an anchored report first when a newer one isn't anchored", async () => {
    const anchored = await reportFrom();
    const newer = await reportFrom();
    const { query } = await queryOver([newer, anchored], { anchorLeaves: [anchored.merkleLeaf] });
    const answer = await query.lookup(PAYEE, "near");
    expect(answer.reports[0]?.reportId).toBe(anchored.reportId);
    expect(answer.merkleProof?.leaf).toBe(anchored.merkleLeaf);
  });

  describe("poisoning: none of these make a payee look reported", () => {
    it("(a) a stranger's well-formed report", async () => {
      const { query } = await queryOver([await reportFrom(generateSigningKey())]);
      expect(await query.lookup(PAYEE, "near")).toMatchObject({ reported: false, reports: [] });
    });

    it("(a) a report naming a trusted reporter, signed by someone else", async () => {
      const attacker = generateSigningKey();
      const forged = await reportFrom(attacker);
      const { query } = await queryOver([{ ...forged, reporter: await publicKeyOf(KEY) }]);
      expect((await query.lookup(PAYEE, "near")).reported).toBe(false);
    });

    it("(b) a report whose verdict signature doesn't verify", async () => {
      const report = await reportFrom();
      const broken = { ...report, evidence: { ...report.evidence, publicVerdict: { ...report.evidence.publicVerdict!, signature: "ab".repeat(64) } } };
      const { query } = await queryOver([broken]);
      expect((await query.lookup(PAYEE, "near")).reported).toBe(false);
    });

    it.each(["verdictId", "verdictSignature", "requestHash", "publicVerdict"] as const)("(c) a report with no %s", async (field) => {
      const report = await reportFrom();
      const { [field]: _gone, ...evidence } = report.evidence;
      const { query } = await queryOver([{ ...report, evidence } as NetworkReport]);
      expect((await query.lookup(PAYEE, "near")).reported).toBe(false);
    });

    it("a payee named in a real report can't be swapped for another", async () => {
      const report = await reportFrom();
      const { query } = await queryOver([{ ...report, payee: "innocent.near" }]);
      expect((await query.lookup("innocent.near", "near")).reported).toBe(false);
    });

    it("a thousand fake reports weigh exactly as much as none", async () => {
      const attacker = generateSigningKey();
      const fake = await reportFrom(attacker);
      const { query } = await queryOver(Array.from({ length: 1000 }, (_, index) => ({ ...fake, reportId: `fake-${index}` })));
      expect(await query.lookup(PAYEE, "near")).toMatchObject({ reported: false, reports: [] });
    });

    it("a seed report counts only where seeds are allowed", async () => {
      const seed = await reportFrom(KEY, {}, true);
      expect((await (await queryOver([seed])).query.lookup(PAYEE, "near")).reported).toBe(false);
      expect((await (await queryOver([seed], { rules: await rulesFor(KEY, true) })).query.lookup(PAYEE, "near")).reported).toBe(true);
    });

    it("a fake report mixed in doesn't hide a real one", async () => {
      const { query } = await queryOver([await reportFrom(generateSigningKey()), await reportFrom()]);
      const answer = await query.lookup(PAYEE, "near");
      expect(answer.reported).toBe(true);
      expect(answer.reports).toHaveLength(1);
    });

    it("an anchored leaf can't vouch for a report that doesn't verify", async () => {
      const report = await reportFrom(generateSigningKey());
      const { query } = await queryOver([report], { anchorLeaves: [report.merkleLeaf] });
      expect(await query.lookup(PAYEE, "near")).toMatchObject({ reported: false, merkleProof: null });
    });
  });

  it("the feed view marks what counts and what's anchored, without hiding the rest", async () => {
    const good = await reportFrom();
    const stranger = await reportFrom(generateSigningKey());
    const { query } = await queryOver([good, stranger], { anchorLeaves: [good.merkleLeaf] });
    const { reports, anchor } = await query.feed(10);
    expect(reports.map(({ reportId, counts, anchored }) => ({ reportId, counts, anchored }))).toEqual([
      { reportId: stranger.reportId, counts: false, anchored: false },
      { reportId: good.reportId, counts: true, anchored: true },
    ]);
    expect(anchor?.txHash).toBe("TX");
  });
});

describe("the anchor record", () => {
  it("is testnet only", () => {
    expect(AnchorRecordSchema.safeParse({ ...anchorOver(["a".repeat(64)]), network: "testnet" }).success).toBe(true);
    expect(AnchorRecordSchema.safeParse({ ...anchorOver(["a".repeat(64)]), network: "mainnet" }).success).toBe(false);
  });
});
