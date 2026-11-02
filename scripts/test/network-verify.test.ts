// Runs the real command a judge would run, on the real anchored feed, then on copies an attacker has changed. Offline
// on purpose: CI shouldn't depend on an RPC, and every local check has to catch these without the chain's help.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnchorRecord, createNetworkReport, feedLineLeaf, type FeedLine, generateSigningKey, makeSignal, merkleRoot, type NetworkReport, parseFeed, publicKeyOf, reportLeaf, serializeFeed, signText, signVerdict } from "@wardy-agent/core";
import { afterAll, describe, expect, it } from "vitest";
import { ANCHOR_FILE, type AnchoredRoot, DUMMY_URI, FEED_FILE, mayAnchorDummy, reasonToRefuse } from "../registry.js";

const dir = mkdtempSync(join(tmpdir(), "wardy-agent-network-verify-test-"));
const feedText = readFileSync(FEED_FILE, "utf8");
const anchorText = readFileSync(ANCHOR_FILE, "utf8");
let serial = 0;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function verify(feed = feedText, anchor = anchorText) {
  serial += 1;
  const feedPath = join(dir, `feed-${serial}.jsonl`);
  const anchorPath = join(dir, `anchor-${serial}.json`);
  writeFileSync(feedPath, feed);
  writeFileSync(anchorPath, anchor);
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/network-verify.ts", "--offline", "--feed", feedPath, "--anchor", anchorPath], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const reportLines = () => parseFeed(feedText) as Extract<FeedLine, { kind: "report" }>[];

/** An anchor that agrees with a changed feed, as a dishonest relay would write. Only the chain can catch this one. */
function anchorFor(lines: FeedLine[]): string {
  const leaves = lines.map(feedLineLeaf);
  return JSON.stringify({ ...(JSON.parse(anchorText) as AnchorRecord), root: merkleRoot(leaves), count: leaves.length, leaves });
}

describe("npm run network:verify", () => {
  it("passes on what's really anchored, and names what it didn't check", () => {
    const { status, output } = verify();
    expect(output).toContain("Everything checked passed");
    expect(output).toContain("not checked, --offline was set");
    expect(output).toContain('"reported": true');
    expect(status).toBe(0);
  });

  it("fails when a report in the feed was edited", () => {
    const { status, output } = verify(feedText.replace("acme-sh0p.near", "innocent-shop.near"));
    expect(output).toContain("FAIL");
    expect(status).toBe(1);
  });

  it("fails when a report was dropped from the feed, even with a matching anchor file", () => {
    const lines = reportLines().slice(1);
    const { status, output } = verify(serializeFeed(lines), anchorFor(lines));
    expect(output).toMatch(/FAIL\s+Every seed report from that run is in the anchored feed/);
    expect(status).toBe(1);
  });

  it("fails when the feed's order changed", () => {
    const { status, output } = verify(serializeFeed([...reportLines()].reverse()));
    expect(output).toMatch(/FAIL\s+The root recomputed from the feed/);
    expect(status).toBe(1);
  });

  it("fails when the record names another root", () => {
    const { status } = verify(feedText, JSON.stringify({ ...(JSON.parse(anchorText) as AnchorRecord), root: "f".repeat(64) }));
    expect(status).toBe(1);
  });

  it("fails on a forged report added with a matching anchor file", async () => {
    const key = generateSigningKey();
    const real = reportLines()[0] as Extract<FeedLine, { kind: "report" }>;
    const { merkleLeaf: _leaf, reportSignature: _signature, ...fields } = { ...real.report, payee: "innocent-shop.near" };
    const merkleLeaf = reportLeaf(fields);
    const forged: FeedLine = { kind: "report", report: { ...fields, merkleLeaf, reportSignature: await signText(merkleLeaf, key) } };
    const lines = [...reportLines(), forged];
    const { status, output } = verify(serializeFeed(lines), anchorFor(lines));
    expect(output).toMatch(/FAIL\s+Every report's signatures and evidence verify/);
    expect(status).toBe(1);
  });

  it("fails if a report ever carries private fields, even with valid signatures elsewhere", () => {
    const [first, ...rest] = reportLines() as [Extract<FeedLine, { kind: "report" }>, ...FeedLine[]];
    const leaky = { ...first, report: { ...first.report, evidence: { ...first.report.evidence, amount: "2" } } } as FeedLine;
    const { status, output } = verify(serializeFeed([leaky, ...rest]));
    expect(output).toMatch(/FAIL\s+No report carries private fields.*amount/);
    expect(status).toBe(1);
  });

  it("the committed feed and anchor agree with each other", () => {
    const record = JSON.parse(anchorText) as AnchorRecord;
    expect(record.network).toBe("testnet");
    expect(parseFeed(feedText).map(feedLineLeaf)).toEqual(record.leaves);
    expect(merkleRoot(record.leaves)).toBe(record.root);
  });
});

describe("npm run demo", () => {
  it("names the anchor only for what this run really produced", () => {
    const record = JSON.parse(anchorText) as AnchorRecord;
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/demo.ts", "--offline"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("signed reports, labelled as seed");
    expect(result.stdout).toContain(record.txUrl);
  });
});

describe("what's allowed on-chain", () => {
  const nobody = async () => false;
  const allReports = () => reportLines().map((line) => line.report);
  const seedReport = () => allReports().find((report) => report.seed) as NetworkReport;
  const realReport = () => allReports().find((report) => !report.seed) as NetworkReport;

  /** Re-signs a changed report, so these test the rule itself and not just the signature. */
  async function resigned(report: NetworkReport, key = generateSigningKey()) {
    const { merkleLeaf: _leaf, reportSignature: _signature, ...fields } = report;
    const merkleLeaf = reportLeaf(fields);
    return { ...fields, merkleLeaf, reportSignature: await signText(merkleLeaf, key) };
  }

  it("a dummy root can't replace a real feed", () => {
    const latest: AnchoredRoot = { root: "a".repeat(64), count: 6, uri: "6 reports", block_height: "1", reporter: "r.testnet" };
    expect(mayAnchorDummy(latest)).toBe(false);
    expect(mayAnchorDummy({ ...latest, uri: DUMMY_URI })).toBe(true);
    expect(mayAnchorDummy(null)).toBe(true);
  });

  it("accepts what's really in the anchored feed", async () => {
    expect(await reasonToRefuse(seedReport(), "seed", nobody)).toBeNull();
    expect(await reasonToRefuse(realReport(), "real run", nobody)).toBeNull();
  });

  it("refuses a report that doesn't verify", async () => {
    expect(await reasonToRefuse({ ...realReport(), payee: "other.testnet" }, "real run", nobody)).toContain("doesn't verify");
    expect(await reasonToRefuse(await resigned(seedReport()), "seed", nobody)).toContain("doesn't verify");
  });

  it("refuses a seed report that hides its label, and a seed passed off as a real run", async () => {
    expect(await reasonToRefuse(realReport(), "seed", nobody)).toContain("unlabelled");
    expect(await reasonToRefuse(seedReport(), "real run", nobody)).toContain("labelled as seed");
  });

  it("refuses to accuse a mainnet name from a real testnet run", async () => {
    // A real report about a real name, with valid signatures, so only this rule stands in the way.
    const key = generateSigningKey();
    const verdict = await signVerdict(
      {
        verdictId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        mode: "pay",
        requestHash: "a".repeat(64),
        payee: "shop.near",
        chain: "near",
        asset: "nep141:wrap.near",
        amount: "2",
        decision: "BLOCK",
        riskScore: 100,
        signals: [makeSignal("LOOKALIKE_HOMOGLYPH", "x", { lookalikeOf: "sh0p.near" }), makeSignal("ACCOUNT_VERY_NEW", "y", {})],
        reasons: ["x"],
        createdAt: "2026-11-05T12:00:00.000Z",
      },
      key,
    );
    const report = await createNetworkReport(verdict, { signingKey: key, createdAt: "2026-11-05T12:00:00.000Z" });
    expect(report.reporter).toBe(await publicKeyOf(key));
    expect(await reasonToRefuse(report, "real run", nobody)).toContain("isn't a testnet account");
  });

  it("refuses to accuse a testnet account that exists and isn't ours", async () => {
    const someoneElse = async () => true;
    expect(await reasonToRefuse(realReport(), "real run", someoneElse)).toContain("don't control");
  });
});
