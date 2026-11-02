// `npm run verify-audit`: recomputes the whole audit hash chain and checks every verdict signature.
// `npm run verify-audit -- <file>` checks another log. Anyone can run this: it needs no keys.
import { existsSync } from "node:fs";
import { AuditLog, OFFLINE_TEST_SIGNING_KEY, publicKeyOf, verifyAuditLines } from "@wardy-agent/core";

const path = process.argv[2] ?? ".data/audit.jsonl";

if (!existsSync(path)) {
  console.log(`No audit log at ${path} yet. Payments create one as they're checked.`);
  process.exit(0);
}

const report = await verifyAuditLines(new AuditLog(path).lines());
if (!report.valid) {
  console.error(`audit chain INVALID at line ${report.problem?.line}: ${report.problem?.reason}`);
  process.exit(1);
}

console.log(`audit chain valid, ${report.entries} entries, ${report.signaturesChecked} signatures valid`);
const offlineKey = await publicKeyOf(OFFLINE_TEST_SIGNING_KEY);
for (const key of report.publicKeys) {
  console.log(`signed by ${key}${key === offlineKey ? " (the public offline test key)" : ""}`);
}
