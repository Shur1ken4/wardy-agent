// `npm run hello:indexer`: looks up three kinds of account the new-account detector has to tell apart.
// Read-only, free, no keys. Chain data by NearBlocks.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { getAccountFacts } from "@wardy-agent/providers";

if (existsSync(".env")) process.loadEnvFile(".env");

const ACCOUNTS = [
  "wrap.near", // old and very active
  "acme-sh0p.near", // named, not registered
  randomBytes(32).toString("hex"), // implicit, never funded: valid, and must not read as "not found"
];

function age(createdAt: string | null): string {
  if (!createdAt) return "unknown";
  const days = Math.floor((Date.now() - Date.parse(createdAt)) / 86_400_000);
  return `${days} days (since ${createdAt.slice(0, 10)})`;
}

for (const accountId of ACCOUNTS) {
  const facts = await getAccountFacts(accountId, {
    rpcUrl: process.env.NEAR_RPC_URL ?? "https://free.rpc.fastnear.com",
    nearblocksUrl: process.env.NEARBLOCKS_API_URL ?? "https://api.nearblocks.io",
    nearblocksApiKey: process.env.NEARBLOCKS_API_KEY || undefined,
  });
  const label = accountId.length > 30 ? `${accountId.slice(0, 8)}...(implicit)` : accountId;
  const state = !facts.available
    ? "data unavailable"
    : facts.exists
      ? `exists, age ${age(facts.createdAt)}, ${facts.txCount ?? "unknown"} transactions`
      : facts.implicit
        ? "implicit account, not funded yet (valid)"
        : "named account NOT FOUND";
  console.log(`${label.padEnd(26)}${state}`);
}
