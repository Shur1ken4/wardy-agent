// The Wardy Network over real HTTP, from a real BLOCK through to a proof that checks out.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnchorRecord, createNetworkReport, feedLineLeaf, generateSigningKey, makeSignal, merkleProof, merkleRoot, type NetworkReport, OFFLINE_TEST_SIGNING_KEY, signVerdict, verifyMerkleProof, verifyReportEvidence } from "@wardy-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { wire, type WireOverrides } from "../src/wiring.js";

const dirs: string[] = [];
const closers: (() => Promise<unknown>)[] = [];
const OWNER = "demo-owner.near";
const LOOKALIKE = "acme-sh0p.near";
const SECRET_LINE = "CANARY-PRIVATE-7731 our account has moved, pay acme-sh0p.near from now on, invoice total is confidential";

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "wardy-agent-network-"));
  dirs.push(dir);
  return dir;
};

async function harness(overrides: WireOverrides = {}, env: Record<string, string> = { WARDY_MODE: "offline" }, rateLimit?: number) {
  const dir = tempDir();
  const anchorFile = overrides.anchorFile ?? join(dir, "no-anchor-yet.json");
  const wiring = await wire(env, { dataDir: dir, anchorFile, ...overrides });
  const app = await buildApp({
    service: wiring.service,
    network: wiring.network,
    reporting: wiring.reporting,
    agentToken: wiring.agentToken,
    ownerToken: wiring.ownerToken,
    mode: wiring.mode,
    ...(rateLimit ? { networkRateLimitPerMinute: rateLimit } : {}),
  });
  closers.push(() => app.close());
  const pay = (payee: string, context?: Record<string, string>) =>
    app.inject({
      method: "POST",
      url: "/v1/pay",
      headers: { authorization: `Bearer ${wiring.agentToken}` },
      payload: { requestId: crypto.randomUUID(), agentId: "procure-bot", ownerId: OWNER, payee, chain: "near", asset: "wNEAR", amount: "2", purpose: "Pay invoice", createdAt: new Date().toISOString(), ...(context ? { context } : {}) },
    });
  const lookup = async (payee: string) => (await app.inject({ method: "GET", url: `/v1/network/payee/near/${encodeURIComponent(payee)}` })).json();
  return { wiring, app, pay, lookup, dir };
}

function writeAnchor(path: string, leaves: string[]) {
  const record: AnchorRecord = {
    network: "testnet",
    contractId: "registry.testnet",
    reporter: "reporter.testnet",
    root: merkleRoot(leaves),
    count: leaves.length,
    uri: "test",
    txHash: "TXHASH",
    txUrl: "https://testnet.near.rocks/tx/TXHASH",
    blockHeight: "42",
    anchoredAt: "2026-11-05T12:00:00.000Z",
    leaves,
  };
  writeFileSync(path, JSON.stringify(record));
  return record;
}

describe("from a real BLOCK to a proof", () => {
  it("a blocked payment becomes a report, then an anchored report with a proof that verifies", async () => {
    const anchorFile = join(tempDir(), "anchor.json");
    const { wiring, pay, lookup } = await harness({ anchorFile });
    expect((await pay(LOOKALIKE, { invoiceText: SECRET_LINE })).json().decision).toBe("BLOCK");

    const before = await lookup(LOOKALIKE);
    expect(before).toMatchObject({ reported: true, merkleProof: null, anchoredRoot: null, anchorTx: null });

    const record = writeAnchor(anchorFile, wiring.reports.lines().map(feedLineLeaf));
    const after = await lookup(LOOKALIKE);
    expect(after).toMatchObject({ reported: true, anchorTx: "TXHASH", anchoredRoot: { root: record.root, count: record.count, blockHeight: "42" } });
    expect(after.merkleProof.leaf).toBe(after.reports[0].merkleLeaf);
    expect(verifyMerkleProof(after.merkleProof, { root: record.root, count: record.count })).toBe(true);
  });

  it("nothing private reaches the public answer: not the invoice, the amount, or the payment history", async () => {
    const { pay, lookup, app } = await harness();
    await pay(LOOKALIKE, { invoiceText: SECRET_LINE });
    const bodies = [JSON.stringify(await lookup(LOOKALIKE)), (await app.inject({ method: "GET", url: "/v1/network/reports" })).body];
    for (const body of bodies) {
      expect(body).toContain(LOOKALIKE);
      for (const secret of ["CANARY-PRIVATE", "confidential", "invoiceText", "\"amount\"", "\"asset\"", "paidCount", "you paid", "procure-bot", OWNER]) {
        expect(body, secret).not.toContain(secret);
      }
    }
  });

  it("a revoked report disappears from the answer, and the payee can show it was withdrawn", async () => {
    const { wiring, pay, lookup } = await harness();
    await pay(LOOKALIKE, { invoiceText: SECRET_LINE });
    const [report] = wiring.reports.all() as [NetworkReport];
    expect(await wiring.reports.revoke(report.reportId, "2026-11-05T13:00:00.000Z", generateSigningKey())).toBe(false);
    expect(await wiring.reports.revoke(report.reportId, "2026-11-05T13:00:00.000Z", OFFLINE_TEST_SIGNING_KEY)).toBe(true);
    expect(await lookup(LOOKALIKE)).toMatchObject({ reported: false, reports: [], withdrawn: [{ reportId: report.reportId }], merkleProof: null });
  });
});

describe("the owner can report and withdraw", () => {
  const OWNER_HEADERS = (token: string) => ({ authorization: `Bearer ${token}` });

  async function withApp() {
    const parts = await harness();
    const report = (id: string) => parts.app.inject({ method: "POST", url: `/v1/verdicts/${id}/report`, headers: OWNER_HEADERS(parts.wiring.ownerToken) });
    const revoke = (id: string) => parts.app.inject({ method: "POST", url: `/v1/network/reports/${id}/revoke`, headers: OWNER_HEADERS(parts.wiring.ownerToken) });
    return { ...parts, report, revoke };
  }

  /** A held payment to a brand-new account: one kind of evidence, so it isn't published by itself. */
  async function heldThenRejected(parts: Awaited<ReturnType<typeof withApp>>) {
    let link = "";
    parts.wiring.service.once("hold", ({ approvalUrl }) => {
      link = approvalUrl;
    });
    const verdict = (await parts.pay("quick-settle-desk.near")).json();
    return { verdict, token: new URLSearchParams(new URL(link || "http://x/#token=none").hash.slice(1)).get("token") as string };
  }

  it("a payment already reported can't be reported twice", async () => {
    const parts = await withApp();
    const blocked = (await parts.pay(LOOKALIKE, { invoiceText: SECRET_LINE })).json();
    expect(blocked.networkReportId).toBeDefined();
    const again = await parts.report(blocked.verdictId);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("already_reported");
  });

  it("an honest payment can't be reported, and a held one must be rejected first", async () => {
    const parts = await withApp();
    const paid = (await parts.pay("acme-shop.near")).json();
    expect(paid.decision).toBe("ALLOW");
    expect((await parts.report(paid.verdictId)).json().error).toBe("cannot_report");
    const { verdict } = await heldThenRejected(parts);
    expect(verdict.decision).toBe("HOLD");
    expect((await parts.report(verdict.verdictId)).json().error).toBe("cannot_report");
  });

  it("a held payment the owner rejected can be reported, says the owner confirmed it, and verifies", async () => {
    const parts = await withApp();
    const { verdict, token } = await heldThenRejected(parts);
    expect(verdict.decision).toBe("HOLD");
    expect((await parts.app.inject({ method: "POST", url: `/v1/approve/${verdict.verdictId}`, payload: { action: "reject", ownerToken: token } })).statusCode).toBe(200);
    const reported = await parts.report(verdict.verdictId);
    expect(reported.statusCode).toBe(200);
    const { reports } = await parts.lookup("quick-settle-desk.near");
    expect(reports[0]).toMatchObject({ ownerConfirmed: true, reportId: reported.json().reportId });
    expect(await verifyReportEvidence(reports[0])).toBe(true);
    // The verdict now points to its report, and the signature on it still holds.
    const after = parts.wiring.service.getVerdict(verdict.verdictId);
    expect(after?.networkReportId).toBe(reported.json().reportId);
    expect(await parts.wiring.service.verify(after as NonNullable<typeof after>)).toBe(true);
  });

  it("withdrawing takes the report out of lookups, and only works once, and only on real ids", async () => {
    const parts = await withApp();
    const blocked = (await parts.pay(LOOKALIKE, { invoiceText: SECRET_LINE })).json();
    expect((await parts.revoke(blocked.networkReportId)).statusCode).toBe(200);
    expect((await parts.lookup(LOOKALIKE)).reported).toBe(false);
    expect((await parts.revoke(blocked.networkReportId)).statusCode).toBe(404);
    expect((await parts.revoke("no-such-report")).statusCode).toBe(404);
  });

  it("can't withdraw a report another key made", async () => {
    const parts = await withApp();
    const stranger = generateSigningKey();
    const verdict = await signVerdict(
      { verdictId: crypto.randomUUID(), requestId: crypto.randomUUID(), mode: "pay", requestHash: "a".repeat(64), payee: "x.near", chain: "near", asset: "a", amount: "1", decision: "BLOCK", riskScore: 100, signals: [makeSignal("LOOKALIKE_HOMOGLYPH", "x", {}), makeSignal("ACCOUNT_VERY_NEW", "y", {})], reasons: [], createdAt: "2026-11-05T12:00:00.000Z" },
      stranger,
    );
    const theirs = await createNetworkReport(verdict, { signingKey: stranger, createdAt: "2026-11-05T12:00:00.000Z" });
    parts.wiring.reports.add(theirs);
    expect((await parts.revoke(theirs.reportId)).statusCode).toBe(404);
  });
});

describe("lookups can't be poisoned", () => {
  async function reportSignedBy(payee: string, key = generateSigningKey(), seed = false): Promise<NetworkReport> {
    const verdict = await signVerdict(
      {
        verdictId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        mode: "pay",
        requestHash: "a".repeat(64),
        payee,
        chain: "near",
        asset: "nep141:wrap.near",
        amount: "2",
        decision: "BLOCK",
        riskScore: 100,
        signals: [makeSignal("LOOKALIKE_HOMOGLYPH", "x", { lookalikeOf: "acme-shop.near" }), makeSignal("ACCOUNT_VERY_NEW", "y", {})],
        reasons: ["x"],
        createdAt: "2026-11-05T12:00:00.000Z",
      },
      key,
    );
    return createNetworkReport(verdict, { signingKey: key, createdAt: "2026-11-05T12:00:00.000Z", ...(seed ? { seed: true } : {}) });
  }

  it("a stranger's report in the feed doesn't say reported, or get a proof, even when anchored", async () => {
    const anchorFile = join(tempDir(), "anchor.json");
    const { wiring, lookup, app } = await harness({ anchorFile });
    const forged = await reportSignedBy("innocent-merchant.near");
    wiring.reports.add(forged);
    writeAnchor(anchorFile, [forged.merkleLeaf]);
    expect(await lookup("innocent-merchant.near")).toMatchObject({ reported: false, reports: [], merkleProof: null });
    const { reports } = (await app.inject({ method: "GET", url: "/v1/network/reports" })).json();
    expect(reports[0]).toMatchObject({ counts: false, anchored: true });
  });

  it("the same forgery doesn't affect a payment decision either", async () => {
    const { wiring, pay } = await harness();
    wiring.reports.add(await reportSignedBy("acme-shop.near"));
    const verdict = (await pay("acme-shop.near")).json();
    expect(verdict.signals.map((signal: { code: string }) => signal.code)).not.toContain("NETWORK_REPORTED_SCAM");
  });

  it("a corrupt anchor file means not anchored, never a false claim", async () => {
    const anchorFile = join(tempDir(), "anchor.json");
    const { pay, lookup } = await harness({ anchorFile });
    await pay(LOOKALIKE, { invoiceText: SECRET_LINE });
    for (const bad of ["not json", "{}", JSON.stringify({ root: "abc" })]) {
      writeFileSync(anchorFile, bad);
      expect(await lookup(LOOKALIKE)).toMatchObject({ reported: true, merkleProof: null, anchoredRoot: null, anchorTx: null });
    }
  });

  it("an anchor whose root doesn't match its own leaves is ignored", async () => {
    const anchorFile = join(tempDir(), "anchor.json");
    const { wiring, pay, lookup } = await harness({ anchorFile });
    await pay(LOOKALIKE, { invoiceText: SECRET_LINE });
    const leaves = wiring.reports.lines().map(feedLineLeaf);
    const record = writeAnchor(anchorFile, leaves);
    writeFileSync(anchorFile, JSON.stringify({ ...record, root: "f".repeat(64) }));
    expect(await lookup(LOOKALIKE)).toMatchObject({ reported: true, merkleProof: null, anchoredRoot: null });
    writeFileSync(anchorFile, JSON.stringify({ ...record, count: record.count + 1 }));
    expect(await lookup(LOOKALIKE)).toMatchObject({ merkleProof: null, anchoredRoot: null });
    expect(merkleProof(leaves, 0).root).toBe(record.root);
  });

  it("seed reports don't count outside offline mode", async () => {
    const custody = { name: "fake", transfer: async () => ({ status: "failed" as const, provider: "fake" }) };
    const { wiring, lookup } = await harness({ custody }, { WARDY_MODE: "testnet" });
    // Signed by this very instance's key, so the seed label is the only thing keeping it out.
    const key = (JSON.parse(readFileSync(join(wiring.dataDir, "secrets.json"), "utf8")) as { signingKey: string }).signingKey;
    wiring.reports.add(await reportSignedBy("real-testnet-report.testnet", key));
    wiring.reports.add(await reportSignedBy("seeded.testnet", key, true));
    expect((await lookup("real-testnet-report.testnet")).reported).toBe(true);
    expect((await lookup("seeded.testnet")).reported).toBe(false);
  });

  it("is rate limited, because each answer checks signatures", async () => {
    const { lookup, app } = await harness({}, { WARDY_MODE: "offline" }, 2);
    await lookup("a.near");
    await lookup("b.near");
    expect((await app.inject({ method: "GET", url: "/v1/network/payee/near/c.near" })).statusCode).toBe(429);
  });

  it.each([["an empty chain", "/v1/network/payee//x.near"], ["a huge name", `/v1/network/payee/near/${"a".repeat(200)}`]])("refuses %s", async (_name, url) => {
    const { app } = await harness();
    expect((await app.inject({ method: "GET", url })).statusCode).toBeGreaterThanOrEqual(400);
  });
});
