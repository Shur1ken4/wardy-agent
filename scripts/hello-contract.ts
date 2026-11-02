// `npm run hello:contract`: deploys the registry to NEAR **testnet** and anchors a dummy root. Free test
// tokens only. Safe to re-run: it skips what's already done and anchors one more dummy root each time.
// Keys stay in the git-ignored .data/ folder. The public addresses go in config/registry.testnet.json.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { actions } from "near-api-js";
import { EXPLORER, ensureAccount, loadKeys, provider, txLink } from "./testnet.js";

const WASM = "contracts/registry/target/near/wardy_network_registry.wasm";
const CONFIG_FILE = "config/registry.testnet.json";
const REGISTRY_ID = "wardy-agent-registry.testnet";
const REPORTER_ID = "wardy-agent-reporter.testnet";
const TGAS_30 = 30_000_000_000_000n;
const TGAS_100 = 100_000_000_000_000n;

async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  return provider.callFunction({ contractId: REGISTRY_ID, method, args }) as Promise<T>;
}

async function isDeployed(): Promise<boolean> {
  try {
    await view("get_owner");
    return true;
  } catch {
    return false;
  }
}

interface AnchoredRoot {
  root: string;
  count: number;
  uri: string;
  block_height: string;
  reporter: string;
}

async function main() {
  if (!existsSync(WASM)) throw new Error(`${WASM} is missing. Run: npm run contract:build`);
  const config: Record<string, unknown> = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, "utf8")) : {};
  const keys = loadKeys();
  const registry = await ensureAccount(REGISTRY_ID, keys);
  const reporter = await ensureAccount(REPORTER_ID, keys);

  if (await isDeployed()) {
    console.log(`Already deployed: ${EXPLORER}/account/${REGISTRY_ID}`);
  } else {
    const result = await registry.signAndSendTransaction({
      receiverId: REGISTRY_ID,
      actions: [
        actions.deployContract(readFileSync(WASM)),
        actions.functionCall("new", { owner: REGISTRY_ID }, TGAS_100, 0n),
      ],
    });
    config.deployTx = result.transaction.hash;
    console.log(`Deployed:    ${txLink(result.transaction.hash)}`);
  }

  if (!(await view<boolean>("is_reporter", { account_id: REPORTER_ID }))) {
    const result = await registry.signAndSendTransaction({
      receiverId: REGISTRY_ID,
      actions: [actions.functionCall("add_reporter", { account_id: REPORTER_ID }, TGAS_30, 0n)],
    });
    console.log(`Reporter:    ${txLink(result.transaction.hash)}`);
  }

  // The owner isn't a registered reporter, so this has to fail on-chain.
  const before = await view<AnchoredRoot | null>("get_latest_root");
  const count = (before?.count ?? 0) + 1;
  try {
    await registry.signAndSendTransaction({
      receiverId: REGISTRY_ID,
      actions: [actions.functionCall("anchor_root", { root: "f".repeat(64), count, uri: "must be refused" }, TGAS_30, 0n)],
    });
    throw new Error("SECURITY FAILURE: an account that isn't a reporter anchored a root.");
  } catch (error) {
    if ((error as Error).message.startsWith("SECURITY FAILURE")) throw error;
    console.log(`Refused:     an unregistered account can't anchor (${(error as Error).message.slice(0, 90)})`);
  }

  // A dummy root, labelled as one. The real report feed arrives in Phase 5.
  const root = createHash("sha256").update(`wardy-agent hello anchor ${count}`).digest("hex");
  const uri = "hello-contract dummy root, not a real report feed";
  const anchored = await reporter.signAndSendTransaction({
    receiverId: REGISTRY_ID,
    actions: [actions.functionCall("anchor_root", { root, count, uri }, TGAS_30, 0n)],
  });
  console.log(`Anchored:    ${txLink(anchored.transaction.hash)}`);

  const latest = await view<AnchoredRoot>("get_latest_root");
  if (latest.root !== root || latest.count !== count) throw new Error("The chain doesn't show the root just anchored.");
  console.log(`On-chain:    root ${latest.root.slice(0, 16)}..., count ${latest.count}, block ${latest.block_height}, by ${latest.reporter}`);

  mkdirSync("config", { recursive: true });
  writeFileSync(
    CONFIG_FILE,
    `${JSON.stringify({ network: "testnet", contractId: REGISTRY_ID, reporter: REPORTER_ID, ...config, helloAnchorTx: anchored.transaction.hash }, null, 2)}\n`,
  );
  console.log(`Saved public addresses to ${CONFIG_FILE}`);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
