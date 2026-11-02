// `npm run network:verify`: checks the Wardy Network's anchor from a clean clone, with no keys. It recomputes the root
// from the feed and compares it with the contract, so it doesn't have to trust the record in this repo. It also asks
// the real API about a seeded payee, and checks the proof that comes back. `--offline` skips the chain.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOffline, SEED_FEED_FILE } from "@wardy-agent/attack-lab";
import { buildApp, wire } from "@wardy-agent/api";
import {
  feedLineLeaf,
  type FeedLine,
  type MerkleProof,
  merkleProof,
  merkleRoot,
  type NetworkReport,
  parseFeed,
  readAnchorRecord,
  revocationLeaf,
  serializeFeed,
  verifyMerkleProof,
  verifyReportEvidence,
  verifyRevocation,
} from "@wardy-agent/core";
import { ANCHOR_FILE, FEED_FILE, latestRoot } from "./registry.js";

const RPC_URL = process.env.NEAR_TESTNET_RPC_URL || "https://test.rpc.fastnear.com";
/** A public report may not hold any of these, however deep. They'd reveal the invoice, the amount, or who the owner pays. */
const PRIVATE_KEYS = new Set(["amount", "asset", "signals", "reasons", "context", "invoiceText", "emailText", "toolOutput", "paidCount", "ownerId", "agentId", "requestId"]);

const flag = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const offline = process.argv.includes("--offline");
const feedPath = flag("--feed") ?? FEED_FILE;
const anchorPath = flag("--anchor") ?? ANCHOR_FILE;

let failures = 0;
function check(what: string, passed: boolean, detail = "") {
  console.log(`  ${passed ? "ok  " : "FAIL"}  ${what}${detail ? `: ${detail}` : ""}`);
  if (!passed) failures += 1;
}
const notChecked = (what: string, why: string) => console.log(`  --    ${what}: not checked, ${why}`);

function privateKeysIn(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) privateKeysIn(item, found);
  else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (PRIVATE_KEYS.has(key)) found.add(key);
      privateKeysIn(inner, found);
    }
  }
  return found;
}

async function revocationIsValid(line: Extract<FeedLine, { kind: "revoke" }>, reports: NetworkReport[]): Promise<boolean> {
  const report = reports.find((candidate) => candidate.reportId === line.reportId && candidate.merkleLeaf === line.reportLeaf);
  return report !== undefined && verifyRevocation({ ...report, revokedAt: line.at, revocationSignature: line.signature });
}

async function askTheApi(seedLines: FeedLine[], payee: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "wardy-agent-network-verify-"));
  try {
    const wiring = await wire({ WARDY_MODE: "offline" }, { dataDir, seedHistory: false, anchorFile: anchorPath });
    wiring.reports.merge(seedLines);
    const app = await buildApp({ service: wiring.service, network: wiring.network, agentToken: wiring.agentToken, ownerToken: wiring.ownerToken, mode: wiring.mode });
    const response = await app.inject({ method: "GET", url: `/v1/network/payee/near/${encodeURIComponent(payee)}` });
    await app.close();
    return response.json() as { reported: boolean; reports: NetworkReport[]; merkleProof: MerkleProof | null; anchoredRoot: { root: string; count: number } | null; anchorTx: string | null };
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/** Reads the transaction itself, because the contract only remembers the latest root. Plain RPCs forget old ones. */
async function anchoredArgs(txHash: string, sender: string): Promise<{ method: string; args: { root?: string; count?: number } } | null> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "wardy-agent", method: "tx", params: { tx_hash: txHash, sender_account_id: sender, wait_until: "NONE" } }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as { result?: { transaction?: { actions?: { FunctionCall?: { method_name: string; args: string } }[] } } };
  const call = body.result?.transaction?.actions?.[0]?.FunctionCall;
  return call ? { method: call.method_name, args: JSON.parse(Buffer.from(call.args, "base64").toString("utf8")) } : null;
}

async function main() {
  console.log("Wardy Network check. It needs no keys.\n");

  const anchor = readAnchorRecord(anchorPath);
  check(`The anchor record in ${anchorPath} is readable and agrees with itself`, anchor !== null);
  if (!anchor || !existsSync(feedPath)) {
    if (!existsSync(feedPath)) check(`The feed ${feedPath} exists`, false);
    return;
  }

  const lines = parseFeed(readFileSync(feedPath, "utf8"));
  const leaves = lines.map(feedLineLeaf);
  const reports = lines.flatMap((line) => (line.kind === "report" ? [line.report] : []));
  const seeded = reports.filter((report) => report.seed);
  console.log(`Feed: ${feedPath}: ${reports.length} reports (${seeded.length} seeded by Attack Lab, ${reports.length - seeded.length} from real testnet runs), ${lines.length - reports.length} revocations\n`);

  const root = merkleRoot(leaves);
  check("The root recomputed from the feed matches the record", root === anchor.root && lines.length === anchor.count, root);

  const fresh = await runOffline();
  const freshLines = fresh.network.lines();
  check(
    "A fresh Attack Lab run produces the committed seed reports, byte for byte",
    existsSync(SEED_FEED_FILE) && readFileSync(SEED_FEED_FILE, "utf8") === serializeFeed(freshLines),
  );
  const leafSet = new Set(leaves);
  check("Every seed report from that run is in the anchored feed", freshLines.every((line) => leafSet.has(feedLineLeaf(line))));

  const verified = await Promise.all(reports.map(verifyReportEvidence));
  check("Every report's signatures and evidence verify, using only the report", verified.every(Boolean), `${verified.filter(Boolean).length} of ${reports.length}`);
  const revocations = lines.flatMap((line) => (line.kind === "revoke" ? [line] : []));
  const revocationsValid = await Promise.all(revocations.map((line) => revocationIsValid(line, reports)));
  check("Every revocation was signed by the report's own reporter", revocationsValid.every(Boolean), `${revocations.length} of them`);
  check("Revocation leaves match the reports they withdraw", revocations.every((line) => leafSet.has(revocationLeaf(line.reportLeaf, line.at)) && leafSet.has(line.reportLeaf)));

  const leaked = privateKeysIn(lines);
  check("No report carries private fields: no invoice text, amount, or payment history", leaked.size === 0, [...leaked].join(", "));

  const proofsOk = leaves.every((_leaf, index) => verifyMerkleProof(merkleProof(leaves, index), { root: anchor.root, count: anchor.count }));
  check("Every line proves against the anchored root", proofsOk, `${leaves.length} proofs`);

  // The real API, asked the way an agent would. The proof it returns is checked against the record, then the chain.
  const example = seeded[0];
  const answer = example ? await askTheApi(lines.filter((line) => line.kind === "report" && line.report.seed), example.payee) : null;
  const exampleProof = answer?.merkleProof ?? null;
  check(
    `The API reports ${example?.payee} and returns a proof that verifies against the anchored root`,
    answer?.reported === true && exampleProof !== null && exampleProof.leaf === answer.reports[0]?.merkleLeaf && verifyMerkleProof(exampleProof, { root: anchor.root, count: anchor.count }),
  );

  if (offline) {
    notChecked("The root on NEAR testnet", "--offline was set");
  } else {
    try {
      const latest = await latestRoot();
      if (latest && latest.count > anchor.count) {
        notChecked("The latest root on NEAR testnet", `the contract has moved on to ${latest.count} leaves, so this clone's feed is older. Run git pull`);
      } else {
        check(`${anchor.contractId} on NEAR testnet holds this exact root and count`, latest?.root === root && latest?.count === lines.length, latest ? `block ${latest.block_height}, anchored by ${latest.reporter}` : "it holds no root");
        if (exampleProof && latest) check("The API's proof verifies against the root read from the chain", verifyMerkleProof(exampleProof, { root: latest.root, count: latest.count }));
      }
    } catch (error) {
      notChecked("The root on NEAR testnet", `couldn't reach the RPC (${(error as Error).message.slice(0, 80)})`);
    }
    try {
      const sent = await anchoredArgs(anchor.txHash, anchor.reporter);
      if (sent) check("The recorded transaction really called anchor_root with this root", sent.method === "anchor_root" && sent.args.root === anchor.root && sent.args.count === anchor.count);
      else notChecked("The recorded transaction", "this RPC doesn't keep transactions that old. Use the explorer link below");
    } catch (error) {
      notChecked("The recorded transaction", `couldn't reach the RPC (${(error as Error).message.slice(0, 80)})`);
    }
  }

  console.log(`\nExplorer: ${anchor.txUrl}`);
  if (answer && example) {
    console.log(`\nWhat an agent gets from GET /v1/network/payee/near/${example.payee} (shortened: the full reports are in the feed):`);
    console.log(
      JSON.stringify(
        {
          reported: answer.reported,
          reports: answer.reports.map(({ payee, codes, seed, evidence }) => ({ payee, codes, seed, lookalikeOf: evidence.lookalikeOf })),
          merkleProof: answer.merkleProof,
          anchoredRoot: answer.anchoredRoot && { root: answer.anchoredRoot.root, count: answer.anchoredRoot.count },
          anchorTx: answer.anchorTx,
        },
        null,
        2,
      ),
    );
  }
}

main().then(
  () => {
    console.log(failures === 0 ? "\nEverything checked passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  },
  (error) => {
    console.error((error as Error).message);
    process.exit(1);
  },
);
