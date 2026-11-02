// The Wardy Network's report feed: append-only JSONL. A revocation is a new line, never a rewrite, so the feed's
// history stays intact and its Merkle root can only grow.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { samePayee } from "../ledger.js";
import type { NetworkReport, Verdict } from "../types.js";
import { createNetworkReport, shouldPublishReport } from "./report.js";

type StoreLine = { kind: "report"; report: NetworkReport } | { kind: "revoke"; reportId: string; at: string };

export class ReportStore {
  private readonly reports: NetworkReport[] = [];

  constructor(private readonly path?: string) {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) this.apply(JSON.parse(line));
  }

  private apply(line: StoreLine) {
    if (line.kind === "report") {
      this.reports.push(line.report);
      return;
    }
    const report = this.reports.find((candidate) => candidate.reportId === line.reportId);
    if (report) report.revokedAt = line.at;
  }

  private write(line: StoreLine) {
    if (this.path) appendFileSync(this.path, `${JSON.stringify(line)}\n`);
    this.apply(line);
  }

  add(report: NetworkReport) {
    this.write({ kind: "report", report });
  }

  /** The reporter withdraws a report. It stops counting at once, and stays in the feed, marked. */
  revoke(reportId: string, at: string): boolean {
    if (!this.reports.some((report) => report.reportId === reportId)) return false;
    this.write({ kind: "revoke", reportId, at });
    return true;
  }

  all(): NetworkReport[] {
    return [...this.reports];
  }

  reportsFor(payee: string, chain: string): NetworkReport[] {
    return this.reports.filter((report) => samePayee(report, { payee, chain }));
  }

  /** Most recent first. */
  recent(limit: number): NetworkReport[] {
    return [...this.reports].reverse().slice(0, limit);
  }
}

/**
 * Publishes a report if this BLOCK warrants one, and returns its id. One live report per payee from one reporter is
 * enough: nothing here counts, so repeats would only pad the feed.
 */
export async function publishIfWarranted(
  store: ReportStore,
  verdict: Verdict,
  options: { signingKey: string; createdAt: string; reportId?: string; seed?: boolean },
): Promise<string | undefined> {
  if (!shouldPublishReport(verdict)) return undefined;
  const alreadyReported = store
    .reportsFor(verdict.payee, verdict.chain)
    .some((report) => report.reporter === verdict.wardyPublicKey && !report.revokedAt);
  if (alreadyReported) return undefined;
  const report = await createNetworkReport(verdict, options);
  store.add(report);
  return report.reportId;
}
