// `npm run demo`: one command. With --offline, or with no setup at all, it needs no keys and no funds. It runs every
// Attack Lab scenario, with and without Wardy Agent, and prints the results. On testnet it makes real test
// transactions. It never moves real money by itself: live mode points you at the steps you run on purpose.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { runOffline, summaryLines } from "@wardy-agent/attack-lab";

const offline = process.argv.includes("--offline");
if (!offline && existsSync(".env")) process.loadEnvFile(".env");
const mode = offline ? "offline" : process.env.WARDY_MODE || "offline";

if (mode === "testnet") {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/walkthrough.ts", "--testnet"], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

if (mode === "live") {
  console.log("Live mode moves real money, so the demo won't do that by itself.");
  console.log("To see everything with no risk, run: npm run demo -- --offline");
  console.log("To make a real payment on purpose, follow Step 6 of docs/SETUP_FOR_SHURIK.md.");
  process.exit(0);
}

const { run, meta } = await runOffline();
console.log(`Wardy Agent demo: ${run.scenarios.length} scenarios, with and without it, on mock ledgers. No keys, no funds.\n`);
for (const line of summaryLines(run)) console.log(line);
console.log(`\nPrivate AI: ${meta.aiSource}`);
console.log("Full results: apps/attack-lab/results/latest.md");

const problems = run.scenarios.flatMap((scenario) => scenario.problems.map((problem) => `${scenario.id}: ${problem}`));
if (problems.length > 0) {
  for (const problem of problems) console.error(`UNEXPECTED ${problem}`);
  process.exit(1);
}
