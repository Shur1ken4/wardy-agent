// `npm run network:anchor`: publishes the Wardy Network feed's Merkle root on NEAR **testnet**. Free test tokens only,
// and it can't reach mainnet: the RPC and accounts come from scripts/testnet.ts. The feed only ever grows, so older
// proofs keep working. `--feed <file>` also adds reports from a real testnet run, as long as they accuse nobody real.
// The reporter's key stays in the git-ignored .data/ folder. The public record goes in config/.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { actions } from "near-api-js";
import { SEED_FEED_FILE } from "@wardy-agent/attack-lab";
import { type AnchorRecord, appendToFeed, feedLineLeaf, type FeedLine, merkleRoot, parseFeed, readAnchorRecord, serializeFeed } from "@wardy-agent/core";
import { ANCHOR_FILE, FEED_FILE, latestRoot, reasonToRefuse, REGISTRY_ID, REPORTER_ID } from "./registry.js";
import { accountExists, ensureAccount, loadKeys, type TestnetKeys, txLink } from "./testnet.js";

const TGAS_30 = 30_000_000_000_000n;

const readFeed = (path: string): FeedLine[] => parseFeed(readFileSync(path, "utf8"));
const reportsIn = (lines: readonly FeedLine[]) => lines.flatMap((line) => (line.kind === "report" ? [line.report] : []));

async function refuseAnythingUnsafe(seed: FeedLine[], extra: FeedLine[], keys: TestnetKeys) {
  const isSomeoneElses = async (accountId: string) => !keys[accountId] && (await accountExists(accountId));
  const reasons = await Promise.all([
    ...reportsIn(seed).map((report) => reasonToRefuse(report, "seed", isSomeoneElses)),
    ...reportsIn(extra).map((report) => reasonToRefuse(report, "real run", isSomeoneElses)),
  ]);
  const reason = reasons.find(Boolean);
  if (reason) throw new Error(reason);
}

function describeFeed(feed: readonly FeedLine[]): string {
  const reports = reportsIn(feed);
  const seeded = reports.filter((report) => report.seed).length;
  return `${seeded} reports seeded by Attack Lab, ${reports.length - seeded} from real testnet runs. Feed: ${FEED_FILE} in the wardy-agent repo`;
}

async function main() {
  const flag = process.argv.indexOf("--feed");
  const extraPath = flag >= 0 ? process.argv[flag + 1] : undefined;
  if (flag >= 0 && !extraPath) throw new Error("--feed needs a file. For example: --feed .data/testnet/network/reports.jsonl");

  const keys = loadKeys();
  if (!keys[REPORTER_ID]) {
    throw new Error("Anchoring needs the reporter's key, which isn't on this machine. You don't need it to check the anchor: run npm run network:verify");
  }

  const seed = readFeed(SEED_FEED_FILE);
  const extra = extraPath ? readFeed(extraPath) : [];
  await refuseAnythingUnsafe(seed, extra, keys);

  const previous = existsSync(FEED_FILE) ? readFeed(FEED_FILE) : [];
  const feed = appendToFeed(previous, [...seed, ...extra]);
  const leaves = feed.map(feedLineLeaf);
  const root = merkleRoot(leaves);
  const count = leaves.length;
  if (count === 0) throw new Error("The feed is empty, so there's nothing to anchor.");

  const before = await latestRoot();
  if (before?.root === root && before.count === count && readAnchorRecord(ANCHOR_FILE)?.root === root) {
    console.log(`Already anchored: root ${root}, ${count} leaves.`);
    console.log(`Transaction: ${readAnchorRecord(ANCHOR_FILE)?.txUrl}`);
    return;
  }
  if (before && (count < before.count || (count === before.count && root !== before.root))) {
    throw new Error(`The contract holds ${before.count} leaves and this feed has ${count}. It only accepts a feed that grows. Is ${FEED_FILE} out of date?`);
  }

  const uri = describeFeed(feed);
  const reporter = await ensureAccount(REPORTER_ID, keys);
  const result = await reporter.signAndSendTransaction({
    receiverId: REGISTRY_ID,
    actions: [actions.functionCall("anchor_root", { root, count, uri }, TGAS_30, 0n)],
  });
  const txHash = result.transaction.hash;

  const after = await latestRoot();
  if (after?.root !== root || after.count !== count) throw new Error(`The chain doesn't show the root just anchored. Transaction: ${txLink(txHash)}`);

  const record: AnchorRecord = {
    network: "testnet",
    contractId: REGISTRY_ID,
    reporter: REPORTER_ID,
    root,
    count,
    uri,
    txHash,
    txUrl: txLink(txHash),
    blockHeight: String(after.block_height),
    anchoredAt: new Date().toISOString(),
    leaves,
  };
  writeFileSync(FEED_FILE, serializeFeed(feed));
  writeFileSync(ANCHOR_FILE, `${JSON.stringify(record, null, 2)}\n`);

  console.log(`Anchored on NEAR testnet: ${uri}`);
  console.log(`Root:        ${root}`);
  console.log(`Leaves:      ${count}`);
  console.log(`Block:       ${after.block_height}`);
  console.log(`Transaction: ${txLink(txHash)}`);
  console.log(`Saved ${FEED_FILE} and ${ANCHOR_FILE}. Commit them, then anyone can check this with: npm run network:verify`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error((error as Error).message);
    process.exit(1);
  },
);
