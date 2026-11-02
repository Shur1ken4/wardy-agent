// `npm run network:seed`: fills this machine's offline registry from the Attack Lab's blocked attempts, so there's
// something to look up. Every report is labelled as seed, and is about a name checked to be unregistered. Seed reports
// only count in offline mode. Needs no keys, and is safe to re-run: it adds only what's missing.
import { join } from "node:path";
import { runOffline } from "@wardy-agent/attack-lab";
import { ReportStore } from "@wardy-agent/core";

const dataDir = process.env.WARDY_DATA_DIR || join(".data", "offline");
const path = join(dataDir, "network", "reports.jsonl");
const { network } = await runOffline();
const store = new ReportStore(path);
const added = store.merge(network.lines());

console.log(`Seeded by Attack Lab: ${network.all().length} reports, ${added} of them new, in ${path}`);
for (const report of network.all()) console.log(`  ${report.payee}  ${report.codes.join(", ")}`);
console.log("\nThese are demo reports. They only count in offline mode, and never in testnet or live decisions.");
console.log("To look one up, run: npm run dev");
console.log(`Then open: http://127.0.0.1:8787/v1/network/payee/near/${network.all()[0]?.payee}`);
console.log("If the server was already running, restart it first.");
process.exit(0);
