// Answers questions about the Wardy Network. It applies the same rules the checker uses, so a lookup can't say
// "reported" about something a payment check would ignore: a forged report, a withdrawn one, or a seed fixture in live
// mode. A proof is against the anchored tree only, because that's the only root a reader can check for themselves.
import type { Chain, NetworkReport } from "../types.js";
import type { AnchorRecord } from "./anchor.js";
import { isValidReport, type ReportRules } from "./lookup.js";
import { type MerkleProof, merkleProof } from "./merkle.js";
import { verifyRevocation } from "./report.js";

export interface AnchorSummary {
  network: string;
  contractId: string;
  root: string;
  count: number;
  uri: string;
  blockHeight: string;
  anchoredAt: string;
  txHash: string;
  txUrl: string;
}

export interface PayeeLookup {
  reported: boolean;
  /** The reports that count. One is enough, and nothing here adds them up. */
  reports: NetworkReport[];
  /** Reports their reporter took back. They count for nothing, and a falsely reported payee can point to them. */
  withdrawn: { reportId: string; revokedAt: string }[];
  /** Proves the first report is in the anchored tree. Null if nothing's reported, or it isn't anchored yet. */
  merkleProof: MerkleProof | null;
  anchoredRoot: AnchorSummary | null;
  anchorTx: string | null;
}

export type FeedEntry = NetworkReport & { counts: boolean; anchored: boolean };

export interface NetworkFeedView {
  reports: FeedEntry[];
  anchor: AnchorSummary | null;
}

export interface NetworkSource {
  lookup(payee: string, chain: Chain | string): Promise<PayeeLookup>;
  feed(limit: number): Promise<NetworkFeedView>;
}

function summarize(anchor: AnchorRecord | null): AnchorSummary | null {
  if (!anchor) return null;
  const { network, contractId, root, count, uri, blockHeight, anchoredAt, txHash, txUrl } = anchor;
  return { network, contractId, root, count, uri, blockHeight, anchoredAt, txHash, txUrl };
}

export class NetworkQuery implements NetworkSource {
  constructor(
    private readonly store: { reportsFor(payee: string, chain: string): NetworkReport[]; recent(limit: number): NetworkReport[] },
    private readonly rules: ReportRules,
    private readonly anchor: () => AnchorRecord | null,
  ) {}

  async lookup(payee: string, chain: string): Promise<PayeeLookup> {
    const anchor = this.anchor();
    const leaves = anchor?.leaves ?? [];
    const counted: NetworkReport[] = [];
    const withdrawn: PayeeLookup["withdrawn"] = [];
    for (const report of this.store.reportsFor(payee, chain)) {
      if (await isValidReport(report, this.rules)) counted.push(report);
      else if (await verifyRevocation(report)) withdrawn.push({ reportId: report.reportId, revokedAt: report.revokedAt as string });
    }
    // Anchored reports first, since those are the ones a reader can check.
    const anchoredFirst = [...counted].sort((a, b) => Number(leaves.includes(b.merkleLeaf)) - Number(leaves.includes(a.merkleLeaf)));
    const index = anchoredFirst[0] ? leaves.indexOf(anchoredFirst[0].merkleLeaf) : -1;
    return {
      reported: counted.length > 0,
      reports: anchoredFirst,
      withdrawn,
      merkleProof: index >= 0 ? merkleProof(leaves, index) : null,
      anchoredRoot: summarize(anchor),
      anchorTx: anchor?.txHash ?? null,
    };
  }

  async feed(limit: number): Promise<NetworkFeedView> {
    const anchor = this.anchor();
    const leaves = new Set(anchor?.leaves ?? []);
    const reports: FeedEntry[] = [];
    for (const report of this.store.recent(limit)) {
      reports.push({ ...report, counts: await isValidReport(report, this.rules), anchored: leaves.has(report.merkleLeaf) });
    }
    return { reports, anchor: summarize(anchor) };
  }
}
