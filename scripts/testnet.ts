// Shared helpers for scripts that use NEAR testnet. Free test tokens only. Keys stay in the git-ignored .data/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { generateNearKey } from "./setup-keys.js";

const RPC_URL = process.env.NEAR_TESTNET_RPC_URL || "https://test.rpc.fastnear.com";
const FAUCET_URL = "https://helper.nearprotocol.com/account";
const ACCOUNTS_FILE = ".data/testnet-accounts.json";

export const EXPLORER = "https://testnet.near.rocks";
export const provider = new JsonRpcProvider({ url: RPC_URL });
export const txLink = (hash: string) => `${EXPLORER}/tx/${hash}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type TestnetKeys = Record<string, string>;

export function loadKeys(): TestnetKeys {
  return existsSync(ACCOUNTS_FILE) ? JSON.parse(readFileSync(ACCOUNTS_FILE, "utf8")) : {};
}

export function saveKeys(keys: TestnetKeys) {
  mkdirSync(".data", { recursive: true });
  writeFileSync(ACCOUNTS_FILE, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
}

export async function accountExists(accountId: string): Promise<boolean> {
  try {
    await provider.viewAccount({ accountId, blockQuery: { finality: "final" } });
    return true;
  } catch {
    return false;
  }
}

/** Returns a usable account, asking the testnet faucet to create it the first time. */
export async function ensureAccount(accountId: string, keys: TestnetKeys): Promise<Account> {
  if (!keys[accountId]) {
    if (await accountExists(accountId)) {
      throw new Error(`${accountId} already exists, and its key isn't in ${ACCOUNTS_FILE}. Choose another name.`);
    }
    keys[accountId] = generateNearKey().privateKey;
    saveKeys(keys); // Saved before the faucet call, so a crash can't lose the key of a created account.
  }
  const privateKey = keys[accountId] as KeyPairString;
  if (!(await accountExists(accountId))) {
    const response = await fetch(FAUCET_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        newAccountId: accountId,
        newAccountPublicKey: KeyPair.fromString(privateKey).getPublicKey().toString(),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`The testnet faucet answered HTTP ${response.status}. Tell Claude; https://near-faucet.io is the fallback.`);
    }
    for (let attempt = 0; attempt < 20 && !(await accountExists(accountId)); attempt += 1) await sleep(1500);
    if (!(await accountExists(accountId))) throw new Error(`${accountId} didn't appear on testnet.`);
    console.log(`Created ${accountId}`);
  }
  return new Account(accountId, provider, privateKey);
}
