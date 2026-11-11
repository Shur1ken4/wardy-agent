import { z } from "zod";
import { isDecimal, parseDecimal } from "./decimal.js";

/** "near", "base", "ethereum", "solana", "arbitrum", or any other chain name. */
export type Chain = string;

const MAX_CONTEXT_CHARS = 20_000;

export const AmountSchema = z
  .string()
  .refine((value) => isDecimal(value) && parseDecimal(value) > 0n, "must be a decimal above zero, such as 2 or 0.01");

export const PaymentRequestSchema = z.strictObject({
  requestId: z.uuid(),
  agentId: z.string().min(1).max(64),
  ownerId: z.string().min(1).max(64),
  // Deliberately loose: a malformed payee is a finding for D5, not a rejected request.
  payee: z.string().min(1).max(128),
  chain: z.string().min(1).max(32).default("near"),
  asset: z.string().min(1).max(256),
  amount: AmountSchema,
  purpose: z.string().max(1000),
  invoiceId: z.string().min(1).max(128).optional(),
  // Untrusted text the agent read. Data only: never instructions, never stored in the Network.
  context: z
    .strictObject({
      invoiceText: z.string().max(MAX_CONTEXT_CHARS).optional(),
      emailText: z.string().max(MAX_CONTEXT_CHARS).optional(),
      toolResultText: z.string().max(MAX_CONTEXT_CHARS).optional(),
      sourceUrl: z.string().max(2048).optional(),
    })
    .optional(),
  createdAt: z.iso.datetime({ offset: true }),
});

export type PaymentRequest = z.output<typeof PaymentRequestSchema>;

export type Decision = "ALLOW" | "HOLD" | "BLOCK";
export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type Detector =
  | "lookalike"
  | "new_account"
  | "duplicate"
  | "context_tamper"
  | "cross_chain"
  | "amount"
  | "network"
  | "policy";

export interface Signal {
  detector: Detector;
  code: string;
  severity: Severity;
  /** Contribution to the risk score. */
  points: number;
  /** Short and human-readable. */
  message: string;
  /** Machine-readable. Must never contain raw context text. */
  evidence: Record<string, unknown>;
}

/** provider_tee: signed in the model's TEE. gateway: signed only by the gateway's TEE. */
export type SignatureKind = "provider_tee" | "gateway" | "none";
export type AttestationLevel = "full" | "partial" | "none";

/** The eight attestation checks, by name, so a verdict can show which passed instead of only a tick. */
export const ATTESTATION_CHECKS = [
  "signatureValid",
  "signedTextMatches",
  "signedByModelTee",
  "signerInReport",
  "gpuVerified",
  "tdxQuoteVerified",
  "reportBindsSigner",
  "reportBindsNonce",
] as const;
export type AttestationCheck = (typeof ATTESTATION_CHECKS)[number];
export type AttestationChecks = Record<AttestationCheck, boolean>;

export interface VerdictAi {
  used: boolean;
  model?: string;
  /** True only when every attestation check passed. */
  attested: boolean;
  attestationRef?: string;
  signatureKind?: SignatureKind;
  attestationLevel?: AttestationLevel;
  /** Each check's result, from a live call. A replayed answer has none. */
  checks?: AttestationChecks;
}

export interface VerdictExecution {
  /** uncertain: custody couldn't confirm either way, so the money may have moved. Never retried automatically. */
  status: "executed" | "pending_owner" | "refused" | "failed" | "uncertain";
  txHash?: string;
  /** The provider's own id for the operation, when it has one. */
  reference?: string;
  provider: string;
  failureCode?: string;
  /** Why, in plain words. */
  note?: string;
}

/** pay: Wardy Agent may execute it. check: a question from another agent; nothing can ever move. */
export type VerdictMode = "pay" | "check";

export interface Verdict {
  verdictId: string;
  requestId: string;
  mode: VerdictMode;
  /** sha256 of the canonical request without its context, so the signature binds to this exact payment. */
  requestHash: string;
  payee: string;
  chain: Chain;
  asset: string;
  amount: string;
  decision: Decision;
  riskScore: number;
  signals: Signal[];
  reasons: string[];
  ai?: VerdictAi;
  /** Changes after the decision, so it isn't signed. The audit chain covers it. */
  execution?: VerdictExecution;
  /** Created from the signed verdict, so it can't be inside the signature. */
  networkReportId?: string;
  wardyPublicKey: string;
  signature: string;
  createdAt: string;
}

/**
 * The part of a verdict a public report may show. The signature covers these fields plus `privateHash`, a hash of the
 * rest, so anyone can check it without learning the amount, the asset, or who the owner has paid before.
 */
export interface PublicVerdict {
  verdictId: string;
  mode: Verdict["mode"];
  requestHash: string;
  payee: string;
  chain: Chain;
  decision: Verdict["decision"];
  riskScore: number;
  wardyPublicKey: string;
  createdAt: string;
  /** What counted against the payee. Limits are left out: they're the owner's business, not evidence. */
  codes: string[];
  lookalikeOf?: string;
  attestationRef?: string;
  privateHash: string;
  signature: string;
}

export interface NetworkReport {
  reportId: string;
  payee: string;
  chain: Chain;
  /** Detector codes that caused the BLOCK. */
  codes: string[];
  evidence: {
    verdictId: string;
    verdictSignature: string;
    /** sha256 of the canonical PaymentRequest without context text. */
    requestHash: string;
    attestationRef?: string;
    lookalikeOf?: string;
    /** The public part of the signed verdict, so anyone can check this report without asking us. */
    publicVerdict?: PublicVerdict;
  };
  /** Public key of the Wardy Agent instance that reported. */
  reporter: string;
  createdAt: string;
  merkleLeaf: string;
  /** The reporter's signature over merkleLeaf, so no field can be changed in transit. */
  reportSignature: string;
  /** Produced by the Attack Lab on fixture names. Never counts in live decisions. */
  seed?: boolean;
  /** The owner looked at this and said it's a scam, which is the other way to earn a public report. */
  ownerConfirmed?: boolean;
  /** Set when the reporter withdraws the report. A revoked report no longer counts. */
  revokedAt?: string;
  /** The reporter's signature over the revocation. Without a valid one, `revokedAt` is ignored. */
  revocationSignature?: string;
}

export interface AccountFacts {
  accountId: string;
  /** False when the source couldn't answer, so existence is unknown. */
  available: boolean;
  exists: boolean;
  /** Valid before it exists on-chain, so "absent" doesn't mean "not found". */
  implicit: boolean;
  /** ISO time, or null when the indexer has no answer. */
  createdAt: string | null;
  txCount: number | null;
}

export interface AccountFactsSource {
  getAccountFacts(accountId: string): Promise<AccountFacts>;
}

/** What the private AI reads out of the untrusted text. It can only add risk. */
export const AiFindingsSchema = z.object({
  payee_change_requested: z.boolean(),
  urgency_or_pressure: z.boolean(),
  asks_to_bypass_limits_or_rules: z.boolean(),
  claims_previous_payment_failed: z.boolean(),
  mentions_new_account_or_address: z.boolean(),
  extracted_payee: z.string().nullish(),
  extracted_amount: z.string().nullish(),
  confidence: z.number().min(0).max(1),
});

export type AiFindings = z.output<typeof AiFindingsSchema>;

export interface ContextAnalysis {
  /** Null when the AI failed or its answer didn't match the schema. */
  findings: AiFindings | null;
  model?: string;
  attested: boolean;
  attestationRef?: string;
  signatureKind?: SignatureKind;
  attestationLevel?: AttestationLevel;
  checks?: AttestationChecks;
}

export interface ContextAnalyzer {
  analyze(document: string): Promise<ContextAnalysis>;
}

export interface CustodyTransfer {
  to: string;
  asset: string;
  amount: string;
  /** Our verdict id, recorded with the payment. */
  memo: string;
  /** The same key must never pay twice. */
  idempotencyKey: string;
}

export interface CustodyResult {
  /** failed: proven not to have moved money. uncertain: it may have. Never report uncertain as failed. */
  status: "executed" | "failed" | "uncertain";
  txHash?: string;
  reference?: string;
  provider: string;
  failureCode?: string;
}

export interface CustodyProvider {
  readonly name: string;
  transfer(request: CustodyTransfer): Promise<CustodyResult>;
  /** What the wallet holds, valued in NEAR. Live mode refuses to start above the safety limit. */
  balanceNearEquivalent?(): Promise<number>;
}
