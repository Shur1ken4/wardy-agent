// `npm run setup:keys`: creates `.env` and fills in brand-new keys, so the owner never has to export a seed
// phrase from a real wallet. Safe to run again: it only fills what's empty. It prints only public account ids.
//   owner    signs the agent's policy and grant; needs a small amount of NEAR to exist on-chain
//   merchant receives the test payment; an implicit account needs no funding to receive
//   signing key and API credentials are for Wardy Agent itself in live mode
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { copyFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { base58 } from "@scure/base";
import { generateSigningKey } from "@wardy-agent/core";

export interface NearKey {
  /** Implicit account id: the public key as 64 hex characters. */
  accountId: string;
  /** `ed25519:` + base58 of (32-byte seed + 32-byte public key), the format NEAR tools expect. */
  privateKey: string;
}

export function generateNearKey(): NearKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return {
    accountId: pub.toString("hex"),
    privateKey: `ed25519:${base58.encode(Buffer.concat([seed, pub]))}`,
  };
}

/** Fills empty `NAME=` lines. Refuses to replace a value that is already set. */
export function fillEnv(text: string, values: Record<string, string>): string {
  let result = text;
  for (const [name, value] of Object.entries(values)) {
    const line = new RegExp(`^${name}=(.*)$`, "m");
    const match = result.match(line);
    if (!match) throw new Error(`${name} is missing from .env`);
    if (match[1]?.trim()) throw new Error(`${name} is already set in .env, leaving it alone`);
    result = result.replace(line, () => `${name}=${value}`);
  }
  return result;
}

function currentValue(text: string, name: string): string {
  return text.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim() ?? "";
}

/** Sets only what's empty or missing, so it's safe to run again. Anything already set is never touched. */
export function fillMissing(text: string, values: Record<string, string>): string {
  let result = text;
  for (const [name, value] of Object.entries(values)) {
    if (currentValue(result, name)) continue;
    const line = new RegExp(`^${name}=.*$`, "m");
    result = line.test(result) ? result.replace(line, () => `${name}=${value}`) : `${result.replace(/\n?$/, "\n")}${name}=${value}\n`;
  }
  return result;
}

function main() {
  if (!existsSync(".env")) copyFileSync(".env.example", ".env");
  chmodSync(".env", 0o600);
  const before = readFileSync(".env", "utf8");
  const values: Record<string, string> = {
    WARDY_SIGNING_KEY: generateSigningKey(),
    WARDY_AGENT_TOKEN: randomBytes(24).toString("hex"),
    WARDY_OWNER_TOKEN: randomBytes(24).toString("hex"),
  };
  // A key and its account belong together, so each pair is only ever created whole.
  if (!currentValue(before, "AGENT_OWNER_PRIVATE_KEY")) {
    const owner = generateNearKey();
    values.AGENT_OWNER_ACCOUNT_ID = owner.accountId;
    values.AGENT_OWNER_PRIVATE_KEY = owner.privateKey;
  }
  if (!currentValue(before, "DEMO_MERCHANT_PRIVATE_KEY")) {
    const merchant = generateNearKey();
    values.DEMO_MERCHANT_ACCOUNT_ID = merchant.accountId;
    values.DEMO_MERCHANT_PRIVATE_KEY = merchant.privateKey;
  }
  const next = fillMissing(before, values);
  writeFileSync(".env", next, { mode: 0o600 });
  console.log(next === before ? "Your .env already has every key. Nothing changed." : "Saved new keys to .env (private keys are not shown here).");
  console.log(`Owner account:    ${currentValue(next, "AGENT_OWNER_ACCOUNT_ID")}`);
  console.log(`Merchant account: ${currentValue(next, "DEMO_MERCHANT_ACCOUNT_ID")}`);
  console.log("Do not send anything to these accounts until Phase 1 asks you to.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
