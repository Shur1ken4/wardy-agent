// `npm run setup:check`: tells Shurik whether each key in `.env` works. Prints OK / MISSING / FAILED per
// service. It makes read-only, free calls, moves no money, and never prints a key.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { KeyPair, type KeyPairString } from "near-api-js";

type Line = { status: "OK" | "MISSING" | "FAILED"; name: string; note: string };

async function getJson(url: string, headers: Record<string, string> = {}, body?: unknown) {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON. The status code is enough.
  }
  return { status: response.status, json };
}

async function checkNearAi(): Promise<Line> {
  const name = "NEAR AI Cloud key";
  const key = process.env.NEAR_AI_CLOUD_API_KEY;
  if (!key) return { status: "MISSING", name, note: "NEAR_AI_CLOUD_API_KEY is empty (Step 1)" };
  const base = process.env.NEAR_AI_CLOUD_BASE_URL ?? "https://cloud-api.near.ai/v1";
  const model = process.env.NEAR_AI_MODEL ?? "z-ai/glm-5.3-flash";
  // Attestation reports need a valid key and are free.
  const query = new URLSearchParams({
    model,
    provider: "near",
    signing_algo: "ecdsa",
    nonce: randomBytes(32).toString("hex"),
  });
  const { status, json } = await getJson(`${base}/attestation/report?${query}`, {
    authorization: `Bearer ${key}`,
    "x-no-aliasing": "true",
  });
  if (status === 401 || status === 403) return { status: "FAILED", name, note: "the key was rejected" };
  if (status !== 200) return { status: "FAILED", name, note: `service answered HTTP ${status}` };
  const count = json?.model_attestations?.length ?? 0;
  return { status: "OK", name, note: `${model}: ${count} TEE attestation report(s)` };
}

async function checkAgentConnect(): Promise<Line> {
  const name = "Agent Connect key";
  const key = process.env.NEAR_INTENTS_AGENT_API_KEY;
  if (!key) return { status: "MISSING", name, note: "NEAR_INTENTS_AGENT_API_KEY is empty (Step 2)" };
  const base = process.env.NEAR_INTENTS_AGENT_API_URL ?? "https://api.agentsonintents.com";
  const { status } = await getJson(`${base}/v1/whoami`, { "x-api-key": key });
  if (status === 401 || status === 403) {
    return { status: "FAILED", name, note: `key rejected by ${base}. Do the key and URL match?` };
  }
  if (status !== 200) return { status: "FAILED", name, note: `service answered HTTP ${status}` };
  return { status: "OK", name, note: `accepted by ${base}` };
}

function checkKey(name: string, accountVar: string, keyVar: string): { line: Line; accountId?: string } {
  const accountId = process.env[accountVar];
  const privateKey = process.env[keyVar];
  if (!accountId || !privateKey) {
    return { line: { status: "MISSING", name, note: "run npm run setup:keys (Step 3)" } };
  }
  try {
    const pair = KeyPair.fromString(privateKey as KeyPairString);
    const implicitId = Buffer.from(pair.getPublicKey().data).toString("hex");
    if (/^[0-9a-f]{64}$/.test(accountId) && accountId !== implicitId) {
      return { line: { status: "FAILED", name, note: `${keyVar} does not belong to ${accountVar}` } };
    }
  } catch {
    return { line: { status: "FAILED", name, note: `${keyVar} is not a valid NEAR key` } };
  }
  return { line: { status: "OK", name, note: accountId }, accountId };
}

async function nearBalance(accountId: string): Promise<string> {
  const rpc = process.env.NEAR_RPC_URL ?? "https://free.rpc.fastnear.com";
  const { json } = await getJson(rpc, {}, {
    jsonrpc: "2.0",
    id: "setup-check",
    method: "query",
    params: { request_type: "view_account", finality: "final", account_id: accountId },
  });
  const yocto = json?.result?.amount;
  if (!yocto) return "not on-chain yet (expected until Phase 1 asks you to fund it)";
  return `holds ${(Number(BigInt(yocto) / 10n ** 20n) / 10_000).toFixed(4)} NEAR`;
}

function checkOwnKeys(): Line {
  const name = "Wardy Agent keys";
  const missing = ["WARDY_SIGNING_KEY", "WARDY_AGENT_TOKEN", "WARDY_OWNER_TOKEN"].filter((key) => !process.env[key]);
  if (missing.length > 0) return { status: "MISSING", name, note: `${missing.join(", ")}: run npm run setup:keys again` };
  return { status: "OK", name, note: "signing key and API credentials are set" };
}

async function guarded(name: string, run: () => Promise<Line>): Promise<Line> {
  try {
    return await run();
  } catch (error) {
    return { status: "FAILED", name, note: `could not reach the service (${(error as Error).name})` };
  }
}

/** Optional: Wardy Agent earns without it, but not on the market. A read of its own assignments proves the token. */
async function checkAgentMarket(): Promise<Line> {
  const name = "Agent Market token";
  const token = process.env.AGENT_MARKET_TOKEN;
  if (!token) return { status: "MISSING", name, note: "AGENT_MARKET_TOKEN is empty (Step 7, optional: skip it for now)" };
  const { status, json } = await getJson("https://market.near.ai/v1/agents/me/assignments", { authorization: `Bearer ${token}` });
  if (status === 401 || status === 403) return { status: "FAILED", name, note: "the token was rejected: make a new one under Agent API tokens" };
  if (status !== 200) return { status: "FAILED", name, note: `the market answered HTTP ${status}` };
  const count = Array.isArray(json?.assignments) ? json.assignments.length : 0;
  return { status: "OK", name, note: `${count} hire(s) in progress` };
}

async function main() {
  if (!existsSync(".env")) {
    console.log("No .env file yet. Run: npm run setup:keys");
    process.exit(1);
  }
  process.loadEnvFile(".env");
  const owner = checkKey("Owner key", "AGENT_OWNER_ACCOUNT_ID", "AGENT_OWNER_PRIVATE_KEY");
  if (owner.accountId) {
    const { accountId } = owner;
    const balance = await nearBalance(accountId).catch(() => "balance unavailable");
    owner.line.note = `${accountId.slice(0, 8)}...${accountId.slice(-6)} ${balance}`;
  }
  const merchant = checkKey("Test merchant key", "DEMO_MERCHANT_ACCOUNT_ID", "DEMO_MERCHANT_PRIVATE_KEY");
  if (merchant.accountId) {
    merchant.line.note = `${merchant.accountId.slice(0, 8)}...${merchant.accountId.slice(-6)}`;
  }
  const lines = [
    await guarded("NEAR AI Cloud key", checkNearAi),
    await guarded("Agent Connect key", checkAgentConnect),
    owner.line,
    merchant.line,
    checkOwnKeys(),
    await guarded("Agent Market token", checkAgentMarket),
  ];
  for (const { status, name, note } of lines) console.log(`${status.padEnd(8)}${name.padEnd(20)}${note}`);
  // The market is optional, so an empty token doesn't hold the rest back.
  const ready = lines.every((line) => line.status === "OK" || (line.name === "Agent Market token" && line.status === "MISSING"));
  console.log(ready ? "\nAll set for Phase 1." : "\nNot ready yet. Fix the lines above (see docs/SETUP_FOR_SHURIK.md).");
  process.exit(ready ? 0 : 1);
}

await main();
