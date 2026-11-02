// Runs every detector on one request, decides, signs, and records. Execution comes in the next phase.
import { randomUUID } from "node:crypto";
import { normalizeAsset } from "./assets.js";
import type { AuditLog } from "./audit.js";
import { decide, type DecisionOutcome } from "./decision.js";
import { contextDocument, contextSignals, hasContextText } from "./detectors/contextTamper.js";
import { crossChainSignals } from "./detectors/crossChain.js";
import { duplicateSignals } from "./detectors/duplicate.js";
import { lookalikeSignals } from "./detectors/lookalike.js";
import { newAccountSignals } from "./detectors/newAccount.js";
import { hashRequest } from "./hash.js";
import type { Ledger } from "./ledger.js";
import { networkSignals, type ReportRules } from "./network/lookup.js";
import { type OwnerPolicy, policySignals } from "./policy.js";
import { signVerdict } from "./sign.js";
import {
  type AccountFacts,
  type AccountFactsSource,
  type ContextAnalysis,
  type ContextAnalyzer,
  type NetworkReport,
  type PaymentRequest,
  PaymentRequestSchema,
  type Signal,
  type Verdict,
  type VerdictAi,
} from "./types.js";

export interface CheckerDeps {
  ledger: Ledger;
  audit: AuditLog;
  policyFor(ownerId: string): OwnerPolicy;
  seedPayees: readonly string[];
  chainData: AccountFactsSource;
  /** Without one, only the deterministic checks read the text, and the verdict says so. */
  analyzer?: ContextAnalyzer;
  reportsFor(payee: string, chain: string): NetworkReport[] | Promise<NetworkReport[]>;
  reportRules: ReportRules;
  signingKey: string;
  now?: () => Date;
  newId?: () => string;
}

export interface Evaluation extends DecisionOutcome {
  signals: Signal[];
  ai: VerdictAi;
}

/** A failed AI call is never fatal. It's reported, and the deterministic signals stand. */
async function analyzeSafely(analyzer: ContextAnalyzer | undefined, request: PaymentRequest): Promise<ContextAnalysis | null> {
  if (!analyzer) return null;
  try {
    return await analyzer.analyze(contextDocument(request));
  } catch {
    return null;
  }
}

async function factsSafely(source: AccountFactsSource, payee: string): Promise<AccountFacts | null> {
  try {
    return await source.getAccountFacts(payee);
  } catch {
    return null;
  }
}

/** Runs all detectors. `request.asset` must already be normalised. */
export async function evaluatePayment(request: PaymentRequest, deps: CheckerDeps, now: Date): Promise<Evaluation> {
  const snapshot = deps.ledger.snapshot(request.ownerId);
  const known = deps.ledger.knownPayees(request.ownerId);

  const analysis = hasContextText(request) ? await analyzeSafely(deps.analyzer, request) : null;
  const facts = request.chain === "near" ? await factsSafely(deps.chainData, request.payee) : null;
  const reports = await deps.reportsFor(request.payee, request.chain);

  const lookalike = lookalikeSignals(request, known, deps.seedPayees);
  const payeeIsKnown = lookalike.some((signal) => signal.code === "KNOWN_PAYEE");
  const signals = [
    ...lookalike,
    ...newAccountSignals(request, facts, now),
    ...duplicateSignals(request, snapshot, now, {
      aiClaimsPaymentFailed: analysis?.findings?.claims_previous_payment_failed ?? false,
    }),
    ...contextSignals(request, analysis),
    ...crossChainSignals(request),
    ...(await networkSignals(request, reports, known, deps.reportRules)),
    ...policySignals(request, deps.policyFor(request.ownerId), snapshot, now, payeeIsKnown),
  ];

  const ai: VerdictAi = analysis?.findings
    ? {
        used: true,
        model: analysis.model,
        attested: analysis.attested,
        attestationRef: analysis.attestationRef,
        signatureKind: analysis.signatureKind,
        attestationLevel: analysis.attestationLevel,
      }
    : { used: false, attested: false };
  return { ...decide(signals), signals, ai };
}

export class PaymentChecker {
  private readonly inFlight = new Map<string, Promise<Verdict>>();

  constructor(private readonly deps: CheckerDeps) {}

  /** Validates, decides and records. The same requestId always returns the original verdict. */
  async check(input: unknown): Promise<Verdict> {
    const parsed = PaymentRequestSchema.parse(input);
    const existing = this.deps.ledger.verdictByRequest(parsed.requestId);
    if (existing) return existing;
    const running = this.inFlight.get(parsed.requestId);
    if (running) return running;
    const started = this.run(parsed).finally(() => this.inFlight.delete(parsed.requestId));
    this.inFlight.set(parsed.requestId, started);
    return started;
  }

  private async run(parsed: PaymentRequest): Promise<Verdict> {
    const { ledger, audit, signingKey } = this.deps;
    const now = this.deps.now?.() ?? new Date();
    const request = { ...parsed, asset: normalizeAsset(parsed.asset) };
    const evaluation = await evaluatePayment(request, this.deps, now);

    // Recorded after evaluating, so velocity counts only earlier requests plus this one.
    ledger.recordRequest({
      requestId: request.requestId,
      ownerId: request.ownerId,
      agentId: request.agentId,
      payee: request.payee,
      chain: request.chain,
      createdAt: now.toISOString(),
    });

    const verdict = await signVerdict(
      {
        verdictId: this.deps.newId?.() ?? randomUUID(),
        requestId: request.requestId,
        requestHash: hashRequest(parsed),
        payee: request.payee,
        chain: request.chain,
        asset: request.asset,
        amount: request.amount,
        decision: evaluation.decision,
        riskScore: evaluation.riskScore,
        signals: evaluation.signals,
        reasons: evaluation.reasons,
        ai: evaluation.ai,
        createdAt: now.toISOString(),
      },
      signingKey,
    );
    ledger.saveVerdict(verdict);
    audit.append({ type: "verdict", at: now.toISOString(), verdict });
    return verdict;
  }
}
