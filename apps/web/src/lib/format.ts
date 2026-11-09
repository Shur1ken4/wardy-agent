// Turning engine data into plain words. Nothing here decides anything, and nothing here makes up a number.
import type { Signal, Verdict, VerdictExecution } from "@wardy-agent/core";

const WNEAR_ASSET = "nep141:wrap.near";
const USDC_ASSET = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export function assetLabel(asset: string): string {
  if (asset === WNEAR_ASSET) return "NEAR";
  if (asset === USDC_ASSET) return "USDC";
  return asset.length > 18 ? `${asset.slice(0, 8)}…${asset.slice(-6)}` : asset;
}

export const formatAmount = (amount: string, asset: string): string => `${amount} ${assetLabel(asset)}`;

export function timeOf(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function dateTimeOf(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

export const shortHash = (hash: string, keep = 10): string => (hash.length > keep * 2 + 1 ? `${hash.slice(0, keep)}…${hash.slice(-6)}` : hash);

export interface PayeePart {
  text: string;
  differs: boolean;
}

/** Splits a payee into the characters that match the real name and the ones that don't. */
export function payeeParts(payee: string, lookalikeOf?: string, positions?: unknown): PayeePart[] {
  const marked = Array.isArray(positions) ? positions.filter((value): value is number => Number.isInteger(value) && value >= 0 && value < payee.length) : [];
  const differs = new Array<boolean>(payee.length).fill(false);
  if (marked.length > 0) {
    for (const index of marked) differs[index] = true;
  } else if (lookalikeOf && lookalikeOf !== payee) {
    let start = 0;
    while (start < payee.length && start < lookalikeOf.length && payee[start] === lookalikeOf[start]) start += 1;
    let end = 0;
    while (end < payee.length - start && end < lookalikeOf.length - start && payee[payee.length - 1 - end] === lookalikeOf[lookalikeOf.length - 1 - end]) end += 1;
    for (let index = start; index < payee.length - end; index += 1) differs[index] = true;
  }
  const parts: PayeePart[] = [];
  for (let index = 0; index < payee.length; index += 1) {
    const last = parts.at(-1);
    if (last && last.differs === differs[index]) last.text += payee[index];
    else parts.push({ text: payee[index] as string, differs: differs[index] as boolean });
  }
  return parts;
}

export function lookalikeSignal(signals: readonly Signal[]): Signal | undefined {
  return signals.find((signal) => signal.detector === "lookalike" && typeof signal.evidence.lookalikeOf === "string");
}

/** Where a real transaction can be seen. A mock ledger has nowhere to link to, so this returns nothing for it. */
export function txUrl(mode: string | undefined, provider: string | undefined, txHash: string | undefined): string | null {
  if (!txHash || provider === "mock") return null;
  if (mode === "testnet") return `https://testnet.near.rocks/tx/${txHash}`;
  if (mode === "live") return `https://near.rocks/tx/${txHash}`;
  return null;
}

export function executionWords(execution: VerdictExecution | undefined): string {
  switch (execution?.status) {
    case "executed":
      return "Paid";
    case "pending_owner":
      return "Waiting for you";
    case "refused":
      return execution.note ?? "Not paid";
    case "failed":
      if (execution.failureCode === "server_daily_limit") return "This server's shared test wallet reached its limit for today. Nothing was sent.";
      return execution.note ?? "The payment failed. Nothing was sent.";
    case "uncertain":
      return "Couldn't confirm. The money may have moved, so it won't be retried.";
    default:
      return "Checking";
  }
}

const CODE_WORDS: Readonly<Record<string, string>> = {
  LOOKALIKE_HOMOGLYPH: "Lookalike name",
  LOOKALIKE_EDIT_DISTANCE: "Lookalike name",
  LOOKALIKE_SUFFIX_TRICK: "Name with a trick ending",
  ACCOUNT_NOT_FOUND: "Account doesn't exist",
  ACCOUNT_VERY_NEW: "Brand-new account",
  ACCOUNT_NEW: "Young account",
  ACCOUNT_LOW_ACTIVITY: "Almost no history",
  CONTEXT_PAYEE_CHANGE: "Asked to change payee",
  CONTEXT_BYPASS_ATTEMPT: "Asked to skip the rules",
  CONTEXT_PAYEE_MISMATCH: "Invoice names someone else",
  CONTEXT_URGENCY: "Pressure to hurry",
  VELOCITY_NEW_PAYEE: "Split into small payments",
  NETWORK_REPORTED_SCAM: "Already reported",
  NETWORK_REPORTED_LOOKALIKE_OF_YOUR_PAYEE: "Imitates your payee",
};

export function codeWords(code: string): string {
  const known = CODE_WORDS[code];
  if (known) return known;
  const words = code.toLowerCase().replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const DUPLICATE_CODES = new Set(["DUPLICATE_INVOICE", "DUPLICATE_PAYMENT_WINDOW", "RETRY_PRESSURE"]);

/** The approval page's question. "Again" is only true when this really looks like a repeat. */
export function approvalQuestion(verdict: Pick<Verdict, "payee" | "amount" | "asset" | "signals">): { headline: string; isRepeat: boolean; firstTx?: string } {
  const repeat = verdict.signals.find((signal) => DUPLICATE_CODES.has(signal.code));
  const firstTx = repeat && typeof repeat.evidence.txHash === "string" ? repeat.evidence.txHash : undefined;
  // The amount and its asset stay on one line.
  const pay = `Pay ${verdict.payee} ${formatAmount(verdict.amount, verdict.asset).replace(" ", "\u00a0")}`;
  return { headline: repeat ? `${pay} again?` : `${pay}?`, isRepeat: Boolean(repeat), ...(firstTx ? { firstTx } : {}) };
}

export const SEVERITY_WORDS: Readonly<Record<string, string>> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Note" };
