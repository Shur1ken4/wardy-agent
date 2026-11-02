// `npm run setup:keys`: creates `.env` and fills in two brand-new NEAR keys, so the owner never has to
// export a seed phrase from a real wallet. It prints only public account ids, never a private key.
//   owner    signs the agent's policy and grant; needs a small amount of NEAR to exist on-chain
//   merchant receives the test payment; an implicit account needs no funding to receive
import { generateKeyPairSync } from "node:crypto";
import { copyFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { base58 } from "@scure/base";

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

function main() {
  if (!existsSync(".env")) copyFileSync(".env.example", ".env");
  chmodSync(".env", 0o600);
  const owner = generateNearKey();
  const merchant = generateNearKey();
  const next = fillEnv(readFileSync(".env", "utf8"), {
    AGENT_OWNER_ACCOUNT_ID: owner.accountId,
    AGENT_OWNER_PRIVATE_KEY: owner.privateKey,
    DEMO_MERCHANT_ACCOUNT_ID: merchant.accountId,
    DEMO_MERCHANT_PRIVATE_KEY: merchant.privateKey,
  });
  writeFileSync(".env", next, { mode: 0o600 });
  console.log("Saved new keys to .env (private keys are not shown here).");
  console.log(`Owner account:    ${owner.accountId}`);
  console.log(`Merchant account: ${merchant.accountId}`);
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
