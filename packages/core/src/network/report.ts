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

/**
 * Evidence about the account itself. Whoever sends the invoice writes its text and chooses how often to ask, so the
 * "context" and "behaviour" families together are still one party's word. A report that names an account for every
 * agent needs something the sender can't write: a name made to look like a payee, or an account that doesn't exist or
 * was made hours ago.
 */
const ABOUT_THE_ACCOUNT: ReadonlySet<string> = new Set(["lookalike", "new_account"]);

function familiesOf(codes: readonly string[]): string[] {
  const families = new Set<string>();
  for (const code of codes) {
    const family = FAMILY[code];
    if (family) families.add(family);
  }
  return [...families];
}

/** Two independent kinds of evidence, at least one of them about the account and not about what was said. */
function enoughEvidence(families: readonly string[]): boolean {
  return families.length >= MIN_FAMILIES && families.some((family) => ABOUT_THE_ACCOUNT.has(family));
}

export function evidenceFamilies(verdict: Verdict): string[] {
  return familiesOf(verdict.signals.map((signal) => signal.code));
}

/** Why the owner can't report this payee, if there's a reason. The owner's word replaces the second kind of evidence, not the first. */
export function whyOwnerCantReport(verdict: Verdict): string | null {
  if (verdict.mode !== "pay") return "A check is only a question, and anyone can send one, so it can't become a report.";
  const rejected = verdict.decision === "HOLD" && verdict.execution?.status === "refused";
  if (verdict.decision !== "BLOCK" && !rejected) return "Only a blocked payment, or a held one you rejected, can become a report.";
  if (verdict.signals.some((signal) => signal.code === "KNOWN_PAYEE")) return "You've really paid this payee before. A tampered invoice attacks them too, so it won't be reported.";
  if (evidenceFamilies(verdict).length === 0) return "Nothing here is evidence about the payee. It only broke one of your own limits.";
  return null;
}

export function shouldPublishReport(verdict: Verdict): boolean {
  if (verdict.mode !== "pay" || verdict.decision !== "BLOCK") return false;
  if (verdict.signals.some((signal) => signal.code === "KNOWN_PAYEE")) return false;
  return enoughEvidence(evidenceFamilies(verdict));
}

/** What goes into the Merkle tree. A revocation isn't in it: that's a later event with its own leaf, not a rewrite. */
export function reportLeaf(report: Omit<NetworkReport, "merkleLeaf" | "reportSignature" | "revokedAt" | "revocationSignature">): string {
  const { reportId, payee, chain, codes, reporter, createdAt, evidence } = report;
  return sha256Hex(canonicalJson({ reportId, payee, chain, codes, reporter, createdAt, evidence, seed: report.seed ?? false, ...(report.ownerConfirmed ? { ownerConfirmed: true } : {}) }));
}

export async function createNetworkReport(verdict: Verdict, options: { signingKey: string; reportId?: string; createdAt: string; seed?: boolean; ownerConfirmed?: boolean }): Promise<NetworkReport> {
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
    ...(options.ownerConfirmed ? { ownerConfirmed: true } : {}),
  };
  const merkleLeaf = reportLeaf(unleafed);
  return { ...unleafed, merkleLeaf, reportSignature: await signText(merkleLeaf, options.signingKey) };
}

/**
 * Anyone can run this with only the report. Two independent checks: the reporter signed this exact report, so no
 * field was changed in transit, and the signed verdict inside really backs up what the report claims. The second
 * stops a reporter, or a bug, from attaching real evidence about one payee to a report about another, or from
 * publishing what the rules wouldn't: a report needs a real BLOCK from a real payment, two independent kinds of
 * evidence, one of them about the account itself, and a payee the owner has never paid. A report the owner confirmed
 * can rest on a held payment and one kind of evidence, and it says so: `ownerConfirmed` is signed, so a reader can weigh it differently.
 */
export async function verifyReportEvidence(report: NetworkReport): Promise<boolean> {
  const { merkleLeaf, reportSignature, revokedAt: _revokedAt, revocationSignature: _revocationSignature, ...fields } = report;
  if (reportLeaf(fields) !== merkleLeaf) return false;
  if (!(await verifyText(merkleLeaf, reportSignature, report.reporter))) return false;

  const { publicVerdict, verdictId, verdictSignature, requestHash, lookalikeOf, attestationRef } = report.evidence;
  if (!publicVerdict) return false;
  const confirmed = report.ownerConfirmed === true;
  if (publicVerdict.mode !== "pay") return false;
  if (publicVerdict.decision !== "BLOCK" && !(confirmed && publicVerdict.decision === "HOLD")) return false;
  if (publicVerdict.verdictId !== verdictId || publicVerdict.signature !== verdictSignature || publicVerdict.requestHash !== requestHash) return false;
  if (publicVerdict.payee !== report.payee || publicVerdict.chain !== report.chain) return false;
  if (publicVerdict.lookalikeOf !== lookalikeOf || publicVerdict.attestationRef !== attestationRef) return false;
  if (canonicalJson(publicVerdict.codes) !== canonicalJson(report.codes)) return false;
  if (publicVerdict.codes.includes("KNOWN_PAYEE")) return false;
  const families = familiesOf(publicVerdict.codes);
  if (confirmed ? families.length < 1 : !enoughEvidence(families)) return false;
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
