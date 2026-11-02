// Network lookup. One valid, evidence-backed report is enough, and nothing here counts or votes, so a thousand
// fake reports weigh exactly as much as none. Phase 5 adds report creation and Merkle proofs.
import { makeSignal } from "../config.js";
import { type KnownPayee, samePayee } from "../ledger.js";
import type { Chain, NetworkReport, Signal } from "../types.js";

export interface ReportRules {
  trustedReporters: ReadonlySet<string>;
  /** Checks the report's evidence, including that its verdict signature verifies. */
  verifyEvidence(report: NetworkReport): boolean | Promise<boolean>;
  /** Attack Lab fixtures count only in offline demos, never in live decisions. */
  allowSeedReports: boolean;
}

export async function isValidReport(report: NetworkReport, rules: ReportRules): Promise<boolean> {
  if (report.revokedAt) return false;
  if (report.seed && !rules.allowSeedReports) return false;
  if (!rules.trustedReporters.has(report.reporter)) return false;
  const { verdictId, verdictSignature, requestHash } = report.evidence ?? {};
  if (!verdictId || !verdictSignature || !requestHash) return false;
  try {
    return await rules.verifyEvidence(report);
  } catch {
    return false;
  }
}

export async function networkSignals(
  request: { payee: string; chain: Chain },
  reports: NetworkReport[],
  known: KnownPayee[],
  rules: ReportRules,
): Promise<Signal[]> {
  const valid: NetworkReport[] = [];
  for (const report of reports) {
    if (samePayee(report, request) && (await isValidReport(report, rules))) valid.push(report);
  }
  const first = valid[0];
  if (!first) return [];

  const signals = [
    makeSignal("NETWORK_REPORTED_SCAM", "The Wardy Network has signed evidence against this payee.", {
      reportId: first.reportId,
      reportIds: valid.map((report) => report.reportId),
      codes: first.codes,
      verdictId: first.evidence.verdictId,
    }),
  ];
  const imitated = valid.map((report) => report.evidence.lookalikeOf).find((lookalikeOf) =>
    known.some((candidate) => candidate.paidCount >= 1 && candidate.accountId === lookalikeOf),
  );
  if (imitated) {
    signals.push(
      makeSignal("NETWORK_REPORTED_LOOKALIKE_OF_YOUR_PAYEE", `It was reported for imitating ${imitated}, a payee you've paid.`, {
        lookalikeOf: imitated,
      }),
    );
  }
  return signals;
}
