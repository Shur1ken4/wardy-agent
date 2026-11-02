// The Wardy Network's report feed: append-only JSONL. A revocation is a new line, never a rewrite, so the feed's
// history stays intact and its Merkle root can only grow. Each line is one leaf of the tree, revocations included, so
// a relay holding the anchored root can't quietly drop one.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { samePayee } from "../ledger.js";
import { publicKeyOf, signText } from "../sign.js";
import type { NetworkReport, Verdict } from "../types.js";
import { createNetworkReport, revocationLeaf, shouldPublishReport } from "./report.js";

export type FeedLine =
  | { kind: "report"; report: NetworkReport }
  | { kind: "revoke"; reportId: string; reportLeaf: string; at: string; signature: string };

export function feedLineLeaf(line: FeedLine): string {
  return line.kind === "report" ? line.report.merkleLeaf : revocationLeaf(line.reportLeaf, line.at);
}

export function serializeFeed(lines: readonly FeedLine[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

export function parseFeed(text: string): FeedLine[] {
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as FeedLine);
}

/** Adds what's new to the end and never touches what's there, so older proofs keep working. */
export function appendToFeed(existing: readonly FeedLine[], additions: readonly FeedLine[]): FeedLine[] {
  const seen = new Set(existing.map(feedLineLeaf));
  const feed = [...existing];
  for (const line of additions) {
    const leaf = feedLineLeaf(line);
    if (seen.has(leaf)) continue;
    seen.add(leaf);
    feed.push(line);
  }
  return feed;
}

export class ReportStore {
  private readonly feed: FeedLine[] = [];
  private readonly reports: NetworkReport[] = [];

  constructor(private readonly path?: string) {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) return;
    for (const line of parseFeed(readFileSync(path, "utf8"))) this.apply(line);
  }

  private apply(line: FeedLine) {
    this.feed.push(line);
    if (line.kind === "report") {
      this.reports.push({ ...line.report }); // A copy: revoking marks this one, and the feed line stays as written.
      return;
    }
    const report = this.reports.find((candidate) => candidate.reportId === line.reportId && candidate.merkleLeaf === line.reportLeaf);
    if (report && !report.revokedAt) {
      report.revokedAt = line.at;
      report.revocationSignature = line.signature;
    }
  }

  private write(line: FeedLine) {
    if (this.path) appendFileSync(this.path, `${JSON.stringify(line)}\n`);
    this.apply(line);
  }

  add(report: NetworkReport) {
    this.write({ kind: "report", report });
  }

  /** Adds lines from another feed, skipping any already here. Returns how many were new. */
  merge(lines: readonly FeedLine[]): number {
    const before = this.feed.length;
    for (const line of appendToFeed(this.feed, lines).slice(before)) this.write(line);
    return this.feed.length - before;
  }

  /**
   * The reporter withdraws a report, signing with its own key. It stops counting at once, and stays in the feed,
   * marked. Returns false if there's no such live report, or the key isn't the reporter's.
   */
  async revoke(reportId: string, at: string, signingKey: string): Promise<boolean> {
    const report = this.reports.find((candidate) => candidate.reportId === reportId);
    if (!report || report.revokedAt) return false;
    if ((await publicKeyOf(signingKey)) !== report.reporter) return false;
    const signature = await signText(revocationLeaf(report.merkleLeaf, at), signingKey);
    this.write({ kind: "revoke", reportId, reportLeaf: report.merkleLeaf, at, signature });
    return true;
  }

  all(): NetworkReport[] {
    return [...this.reports];
  }

  /** The feed as written, in order. */
  lines(): FeedLine[] {
    return [...this.feed];
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
