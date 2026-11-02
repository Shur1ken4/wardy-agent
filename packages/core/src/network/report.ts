// Turning a BLOCK into a public report. A signed verdict proves Wardy Agent's opinion, not that a payee is a
// scammer, and a report blocks that payee for every agent. So one suspicion stays local. A report needs two
// independent kinds of evidence, and never comes from a payee the owner has really paid: a tampered invoice from
// a real merchant is an attack on the merchant too. The feed is public, so a report carries only the public part of
// its verdict: never the context text, the amount, or who the owner has paid before.
import { randomUUID } from "node:crypto";
import { canonicalJson } from "../canonical.js";
import { sha256Hex } from "../hash.js";
import { publicVerdictOf, signText, verifyPublicVerdict, verifyText } from "../sign.js";
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

function familiesOf(codes: readonly string[]): string[] {
  const families = new Set<string>();
  for (const code of codes) {
    const family = FAMILY[code];
    if (family) families.add(family);
  }
  return [...families];
}

export function evidenceFamilies(verdict: Verdict): string[] {
  return familiesOf(verdict.signals.map((signal) => signal.code));
}

export function shouldPublishReport(verdict: Verdict): boolean {
  if (verdict.mode !== "pay" || verdict.decision !== "BLOCK") return false;
  if (verdict.signals.some((signal) => signal.code === "KNOWN_PAYEE")) return false;
  return evidenceFamilies(verdict).length >= MIN_FAMILIES;
}

/** What goes into the Merkle tree. A revocation isn't in it: that's a later event with its own leaf, not a rewrite. */
export function reportLeaf(report: Omit<NetworkReport, "merkleLeaf" | "reportSignature" | "revokedAt" | "revocationSignature">): string {
  const { reportId, payee, chain, codes, reporter, createdAt, evidence } = report;
  return sha256Hex(canonicalJson({ reportId, payee, chain, codes, reporter, createdAt, evidence, seed: report.seed ?? false }));
}

export async function createNetworkReport(verdict: Verdict, options: { signingKey: string; reportId?: string; createdAt: string; seed?: boolean }): Promise<NetworkReport> {
  const publicVerdict = publicVerdictOf(verdict);
  const unleafed = {
    reportId: options.reportId ?? randomUUID(),
    payee: verdict.payee,
    chain: verdict.chain,
    codes: publicVerdict.codes,
    evidence: {
      verdictId: verdict.verdictId,
      verdictSignature: verdict.signature,
      requestHash: verdict.requestHash,
      ...(publicVerdict.attestationRef ? { attestationRef: publicVerdict.attestationRef } : {}),
      ...(publicVerdict.lookalikeOf ? { lookalikeOf: publicVerdict.lookalikeOf } : {}),
      publicVerdict,
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
 * stops a reporter, or a bug, from attaching real evidence about one payee to a report about another, or from
 * publishing what the rules wouldn't: a report needs a real BLOCK from a real payment, two independent kinds of
 * evidence, and a payee the owner has never paid.
 */
export async function verifyReportEvidence(report: NetworkReport): Promise<boolean> {
  const { merkleLeaf, reportSignature, revokedAt: _revokedAt, revocationSignature: _revocationSignature, ...fields } = report;
  if (reportLeaf(fields) !== merkleLeaf) return false;
  if (!(await verifyText(merkleLeaf, reportSignature, report.reporter))) return false;

  const { publicVerdict, verdictId, verdictSignature, requestHash, lookalikeOf, attestationRef } = report.evidence;
  if (!publicVerdict) return false;
  if (publicVerdict.mode !== "pay" || publicVerdict.decision !== "BLOCK") return false;
  if (publicVerdict.verdictId !== verdictId || publicVerdict.signature !== verdictSignature || publicVerdict.requestHash !== requestHash) return false;
  if (publicVerdict.payee !== report.payee || publicVerdict.chain !== report.chain) return false;
  if (publicVerdict.lookalikeOf !== lookalikeOf || publicVerdict.attestationRef !== attestationRef) return false;
  if (canonicalJson(publicVerdict.codes) !== canonicalJson(report.codes)) return false;
  if (publicVerdict.codes.includes("KNOWN_PAYEE") || familiesOf(publicVerdict.codes).length < MIN_FAMILIES) return false;
  return verifyPublicVerdict(publicVerdict, report.reporter);
}

/** A revocation is a leaf of its own in the feed, so an anchored root commits to it as well. */
export function revocationLeaf(reportLeafHash: string, revokedAt: string): string {
  return sha256Hex(canonicalJson({ kind: "revocation", reportLeaf: reportLeafHash, revokedAt }));
}

/** Only the reporter can withdraw a report. A forged revocation can't get a payee off the list. */
export async function verifyRevocation(report: NetworkReport): Promise<boolean> {
  if (!report.revokedAt || !report.revocationSignature) return false;
  return verifyText(revocationLeaf(report.merkleLeaf, report.revokedAt), report.revocationSignature, report.reporter);
}
