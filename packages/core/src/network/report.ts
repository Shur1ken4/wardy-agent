// Turning a BLOCK into a public report. A signed verdict proves Wardy Agent's opinion, not that a payee is a
// scammer, and a report blocks that payee for every agent. So one suspicion stays local. A report needs two
// independent kinds of evidence, and never comes from a payee the owner has really paid: a tampered invoice from
// a real merchant is an attack on the merchant too.
import { randomUUID } from "node:crypto";
import { canonicalJson } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import { signText, verifyText, verifyVerdict } from "../sign.js";
import type { NetworkReport, Verdict } from "../types.js";

/** Which independent kind of evidence each signal is. Limits and urgency aren't evidence about a payee. */
const FAMILY: Readonly<Record<string, string>> = {
  LOOKALIKE_HOMOGLYPH: "lookalike",
  LOOKALIKE_EDIT_DISTANCE: "lookalike",
  LOOKALIKE_SUFFIX_TRICK: "lookalike",
  ACCOUNT_NOT_FOUND: "new_account",
  ACCOUNT_VERY_NEW: "new_account",
  CONTEXT_PAYEE_CHANGE: "context",
  CONTEXT_BYPASS_ATTEMPT: "context",
  CONTEXT_PAYEE_MISMATCH: "context",
  VELOCITY_NEW_PAYEE: "behaviour",
};

const MIN_FAMILIES = 2;

export function evidenceFamilies(verdict: Verdict): string[] {
  const families = new Set<string>();
  for (const signal of verdict.signals) {
    const family = FAMILY[signal.code];
    if (family) families.add(family);
  }
  return [...families];
}

export function shouldPublishReport(verdict: Verdict): boolean {
  if (verdict.mode !== "pay" || verdict.decision !== "BLOCK") return false;
  if (verdict.signals.some((signal) => signal.code === "KNOWN_PAYEE")) return false;
  return evidenceFamilies(verdict).length >= MIN_FAMILIES;
}

/** What goes into the Merkle tree. `revokedAt` isn't in it: a revocation is a later event, not a rewrite. */
export function reportLeaf(report: Omit<NetworkReport, "merkleLeaf" | "reportSignature" | "revokedAt">): string {
  const { reportId, payee, chain, codes, reporter, createdAt, evidence } = report;
  return sha256Hex(canonicalJson({ reportId, payee, chain, codes, reporter, createdAt, evidence, seed: report.seed ?? false }));
}

export async function createNetworkReport(verdict: Verdict, options: { signingKey: string; reportId?: string; createdAt: string; seed?: boolean }): Promise<NetworkReport> {
  const lookalikeOf = verdict.signals.find((signal) => signal.detector === "lookalike" && signal.evidence.lookalikeOf)?.evidence.lookalikeOf;
  // The signed copy is what lets anyone check this report. It has no context text, and execution isn't part of it.
  const { execution: _execution, networkReportId: _networkReportId, ...signedVerdict } = verdict;
  const unleafed = {
    reportId: options.reportId ?? randomUUID(),
    payee: verdict.payee,
    chain: verdict.chain,
    codes: verdict.signals.filter((signal) => signal.points > 0 && signal.detector !== "policy").map((signal) => signal.code),
    evidence: {
      verdictId: verdict.verdictId,
      verdictSignature: verdict.signature,
      requestHash: verdict.requestHash,
      ...(verdict.ai?.attestationRef ? { attestationRef: verdict.ai.attestationRef } : {}),
      ...(typeof lookalikeOf === "string" ? { lookalikeOf } : {}),
      signedVerdict,
    },
    reporter: verdict.wardyPublicKey,
    createdAt: options.createdAt,
    ...(options.seed ? { seed: true } : {}),
  };
  const merkleLeaf = reportLeaf(unleafed);
  return { ...unleafed, merkleLeaf, reportSignature: await signText(merkleLeaf, options.signingKey) };
}

/**
 * Anyone can run this with only the report. Two independent checks: the reporter signed this exact report, so no
 * field was changed in transit, and the signed verdict inside really backs up what the report claims. The second
 * stops a reporter, or a bug, from attaching real evidence about one payee to a report about another.
 */
export async function verifyReportEvidence(report: NetworkReport): Promise<boolean> {
  const { merkleLeaf, reportSignature, revokedAt: _revokedAt, ...fields } = report;
  if (reportLeaf(fields) !== merkleLeaf) return false;
  if (!(await verifyText(merkleLeaf, reportSignature, report.reporter))) return false;

  const { signedVerdict, verdictId, verdictSignature, requestHash } = report.evidence;
  if (!signedVerdict) return false;
  if (signedVerdict.decision !== "BLOCK") return false;
  if (signedVerdict.verdictId !== verdictId || signedVerdict.signature !== verdictSignature || signedVerdict.requestHash !== requestHash) return false;
  if (signedVerdict.payee !== report.payee || signedVerdict.chain !== report.chain) return false;
  return verifyVerdict(signedVerdict, report.reporter);
}
