// `npm run check:fixtures`: confirms our demo account names are still unregistered on NEAR mainnet. Anyone can
// register a name at any time, and a demo must never accuse a real account. Read-only, no keys. Run it again
// before submitting.
import accounts from "../packages/providers/fixtures/accounts.json" with { type: "json" };
import { getAccountFacts } from "@wardy-agent/providers";

const options = { rpcUrl: process.env.NEAR_RPC_URL || "https://free.rpc.fastnear.com", nearblocksUrl: "https://api.nearblocks.io" };
let problems = 0;

for (const accountId of Object.keys(accounts)) {
  const facts = await getAccountFacts(accountId, options);
  if (!facts.available) {
    console.log(`UNKNOWN  ${accountId}: couldn't reach NEAR`);
    problems += 1;
  } else if (facts.exists) {
    console.log(`TAKEN    ${accountId}: this is now a real account, so rename the fixture`);
    problems += 1;
  } else {
    console.log(`free     ${accountId}`);
  }
}

if (problems > 0) process.exit(1);
console.log("All fixture names are unregistered.");
