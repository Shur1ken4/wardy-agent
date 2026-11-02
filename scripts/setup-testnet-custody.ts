// `npm run setup:testnet`: prepares free testnet custody so `WARDY_MODE=testnet` makes real transactions with
// no real money: an OutLayer testnet wallet, funded with test NEAR, and a test merchant. Safe to re-run.
// Keys stay in the git-ignored .data/ folder and are never printed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { toAtomic } from "@wardy-agent/providers";
import { ensureAccount, loadKeys, txLink } from "./testnet.js";

const API = process.env.OUTLAYER_API_URL || "https://testnet-api.outlayer.ai";
const WALLET_FILE = ".data/outlayer-testnet.json";
const FUNDER_ID = "wardy-agent-reporter.testnet";
export const TEST_MERCHANT_ID = "wardy-agent-shop.testnet";
const TOP_UP_BELOW = toAtomic("1", 24);
const TOP_UP = toAtomic("2", 24);

if (!API.includes("testnet")) throw new Error("This script only works on testnet.");

interface Wallet {
  apiKey: string;
  accountId: string;
}

async function loadOrRegisterWallet(): Promise<Wallet> {
  if (existsSync(WALLET_FILE)) return JSON.parse(readFileSync(WALLET_FILE, "utf8"));
  const response = await fetch(`${API}/register`, { method: "POST", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`OutLayer registration answered HTTP ${response.status}.`);
  const body = (await response.json()) as { api_key: string; near_account_id: string };
  const wallet = { apiKey: body.api_key, accountId: body.near_account_id };
  mkdirSync(".data", { recursive: true });
  writeFileSync(WALLET_FILE, `${JSON.stringify(wallet, null, 2)}\n`, { mode: 0o600 });
  console.log("Registered an OutLayer testnet wallet.");
  return wallet;
}

async function balanceYocto(wallet: Wallet): Promise<bigint> {
  const response = await fetch(`${API}/wallet/v1/balance?chain=near`, {
    headers: { authorization: `Bearer ${wallet.apiKey}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Balance check answered HTTP ${response.status}.`);
  const body = (await response.json()) as { balance?: string };
  return BigInt(body.balance ?? "0");
}

const wallet = await loadOrRegisterWallet();
console.log(`Custody wallet:  ${wallet.accountId}`);

const keys = loadKeys();
const merchant = await ensureAccount(TEST_MERCHANT_ID, keys);
console.log(`Test merchant:   ${merchant.accountId}`);

const before = await balanceYocto(wallet);
if (before < TOP_UP_BELOW) {
  const funder = await ensureAccount(FUNDER_ID, keys);
  const result = await funder.transfer({ receiverId: wallet.accountId, amount: TOP_UP });
  console.log(`Funded wallet:   ${txLink(result.transaction.hash)}`);
}
// A balance read right after funding can lag the chain by a few seconds.
let balance = await balanceYocto(wallet);
for (let attempt = 0; attempt < 10 && balance < before + 1n && before < TOP_UP_BELOW; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  balance = await balanceYocto(wallet);
}
console.log(`Wallet balance:  ${Number(balance / 10n ** 21n) / 1000} test NEAR`);
