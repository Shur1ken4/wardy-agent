// The only path to moving money. Takes a payment from request to verdict to execution, asks the owner on HOLD,
// and refuses on BLOCK. Each owner's payments run strictly one at a time: the duplicate check reads what has
// already settled, so two identical requests in parallel would otherwise both pass and both pay.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { type AuditEntry, type AuditRecord, verifyAuditLines } from "./audit.js";
import { type CheckerDeps, PaymentChecker } from "./checker.js";
import { SIGNALS, type SignalCode } from "./config.js";
import { formatDecimal, parseDecimal } from "./decimal.js";
import { type NextStep, nextStepFor } from "./nextStep.js";
import { type OwnerPolicy, policySignals } from "./policy.js";
import { publicKeyOf, verifyVerdict } from "./sign.js";
import {
  type CustodyProvider,
  type CustodyResult,
  PaymentRequestSchema,
  type Verdict,
  type VerdictExecution,
} from "./types.js";

const DEFAULT_APPROVAL_TTL_MS = 30 * 60_000;
const OWNER_REJECTED_NOTE = "You rejected this payment.";

/** A verdict plus details that aren't part of what's signed. */
export type VerdictView = Verdict & { agentId?: string; nextStep?: NextStep };

/** What a worker agent gets to know about a payment it asked for: the outcome, and nothing about the owner. */
export interface PaymentStatus {
  verdictId: string;
  decision: Verdict["decision"];
  paid: boolean;
  status: VerdictExecution["status"] | null;
  nextStep: NextStep;
  txHash?: string;
  /** Only while the owner is deciding. */
  decideBy?: string;
}

/** A refusal the caller should see, with the HTTP status that fits it. */
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export interface ServiceDeps extends Omit<CheckerDeps, "policyFor"> {
  custody: CustodyProvider;
  /** The one owner whose fleet this instance spends for. */
  fleetOwnerId: string;
  policy: OwnerPolicy;
  /** Where the owner goes to decide. The URL carries the one-time token, so it goes only to the owner. */
  approvalUrl(verdictId: string, token: string): string;
  approvalTtlMs?: number;
  /** Called on every BLOCK of a real payment. The Wardy Network plugs in here, and returns a report id if it made one. */
  onBlocked?(verdict: Verdict): string | undefined | void | Promise<string | undefined | void>;
}

export interface HoldNotice {
  verdict: Verdict;
  /** Carries the one-time token. For the owner's eyes only. */
  approvalUrl: string;
  expiresAt: string;
}

export interface ServiceEvents {
  verdict: [Verdict];
  hold: [HoldNotice];
  frozen: [boolean];
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export class PaymentService extends EventEmitter<ServiceEvents> {
  private readonly checker: PaymentChecker;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ServiceDeps) {
    super();
    this.checker = new PaymentChecker({ ...deps, policyFor: (ownerId) => this.policyFor(ownerId) });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private policyFor(ownerId: string): OwnerPolicy | null {
    if (ownerId !== this.deps.fleetOwnerId) return null;
    return this.currentPolicy();
  }

  currentPolicy(): OwnerPolicy {
    return { ...this.deps.policy, frozen: this.deps.policy.frozen || this.deps.ledger.isFrozen() };
  }

  isFrozen(): boolean {
    return this.currentPolicy().frozen;
  }

  get providerName(): string {
    return this.deps.custody.name;
  }

  get fleetOwnerId(): string {
    return this.deps.fleetOwnerId;
  }

  view(verdict: Verdict): VerdictView {
    const agentId = this.deps.ledger.requestRecord(verdict.requestId)?.agentId;
    return { ...verdict, ...(agentId ? { agentId } : {}), nextStep: nextStepFor(verdict) };
  }

  recentVerdicts(limit: number): VerdictView[] {
    return this.deps.ledger.recentVerdicts(limit).map((verdict) => this.view(verdict));
  }

  getVerdict(verdictId: string): VerdictView | undefined {
    const verdict = this.deps.ledger.verdictById(verdictId);
    return verdict ? this.view(verdict) : undefined;
  }

  /** Pinned to this instance's key, so a verdict signed by anyone else fails. */
  async verify(verdict: Verdict): Promise<boolean> {
    return verifyVerdict(verdict, await publicKeyOf(this.deps.signingKey));
  }

  publicKey(): Promise<string> {
    return publicKeyOf(this.deps.signingKey);
  }

  /** Runs one thing at a time. A failure doesn't stop what's queued behind it. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** A payment from our own fleet. Executes on ALLOW. */
  async pay(input: unknown): Promise<Verdict> {
    const parsed = PaymentRequestSchema.parse(input);
    if (parsed.ownerId !== this.deps.fleetOwnerId) {
      throw new ServiceError(403, "unknown_owner", "This Wardy Agent doesn't spend for that owner.");
    }
    return this.serial(async () => {
      this.expireHolds();
      const verdict = await this.checker.check(parsed, "pay");
      // Already handled: a replay returns the first answer and can't pay again.
      if (verdict.execution) return verdict;
      if (verdict.decision === "ALLOW") return this.execute(verdict);
      if (verdict.decision === "HOLD") return this.hold(verdict);
      const refused = this.setExecution(verdict, { status: "refused", provider: this.providerName });
      const networkReportId = await this.deps.onBlocked?.(refused);
      if (!networkReportId) return refused;
      const reported: Verdict = { ...refused, networkReportId };
      this.deps.ledger.saveVerdict(reported);
      this.emit("verdict", reported);
      return reported;
    });
  }

  /** A question from any agent. Nothing can move, whatever the answer. */
  async check(input: unknown): Promise<Verdict> {
    const verdict = await this.checker.check(input, "check");
    this.emit("verdict", verdict);
    return verdict;
  }

  private setExecution(verdict: Verdict, execution: VerdictExecution): Verdict {
    const updated: Verdict = { ...verdict, execution };
    this.deps.ledger.saveVerdict(updated);
    this.deps.audit.append({ type: "execution", at: this.now().toISOString(), verdictId: verdict.verdictId, execution });
    this.emit("verdict", updated);
    return updated;
  }

  private async execute(verdict: Verdict): Promise<Verdict> {
    const { custody, ledger } = this.deps;
    if (verdict.chain !== "near") {
      return this.setExecution(verdict, {
        status: "failed",
        provider: custody.name,
        failureCode: "chain_not_supported",
        note: "Wardy Agent can't yet execute payments on this chain.",
      });
    }
    let result: CustodyResult;
    try {
      result = await custody.transfer({
        to: verdict.payee,
        asset: verdict.asset,
        amount: verdict.amount,
        memo: verdict.verdictId,
        // The request id, so a resume after a crash can't pay twice.
        idempotencyKey: verdict.requestId,
      });
    } catch {
      // No answer doesn't mean no payment.
      result = { status: "uncertain", provider: custody.name, failureCode: "custody_no_answer" };
    }

    // Uncertain counts as paid: if it did go through, a retry must not pay a second time.
    if (result.status !== "failed") {
      const record = ledger.requestRecord(verdict.requestId);
      ledger.recordSettled({
        requestId: verdict.requestId,
        ownerId: this.deps.fleetOwnerId,
        payee: verdict.payee,
        chain: verdict.chain,
        asset: verdict.asset,
        amount: verdict.amount,
        settledAt: this.now().toISOString(),
        ...(result.txHash ? { txHash: result.txHash } : {}),
        ...(record?.invoiceId ? { invoiceId: record.invoiceId } : {}),
        ...(record?.invoiceTextHash ? { invoiceTextHash: record.invoiceTextHash } : {}),
        ...(result.status === "uncertain" ? { uncertain: true } : {}),
      });
    }
    return this.setExecution(verdict, {
      status: result.status,
      provider: result.provider,
      ...(result.txHash ? { txHash: result.txHash } : {}),
      ...(result.reference ? { reference: result.reference } : {}),
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
      ...(result.status === "uncertain" ? { note: "Custody couldn't confirm this payment. Check it before paying again." } : {}),
    });
  }

  private issueApproval(verdictId: string, expiresAt: string): string {
    const token = randomBytes(32).toString("hex");
    this.deps.ledger.saveApproval({ verdictId, tokenHash: hashToken(token), expiresAt });
    return this.deps.approvalUrl(verdictId, token);
  }

  private hold(verdict: Verdict): Verdict {
    const ttl = this.deps.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    const expiresAt = new Date(this.now().getTime() + ttl).toISOString();
    const approvalUrl = this.issueApproval(verdict.verdictId, expiresAt);
    const held = this.setExecution(verdict, { status: "pending_owner", provider: this.providerName });
    this.emit("hold", { verdict: held, approvalUrl, expiresAt });
    return held;
  }

  /** The owner's answer to a HOLD. The token works once. An agent never receives one. */
  async decideHold(verdictId: string, action: "approve" | "reject", token: string): Promise<Verdict> {
    return this.serial(async () => {
      this.expireHolds();
      const { ledger } = this.deps;
      const verdict = ledger.verdictById(verdictId);
      if (!verdict) throw new ServiceError(404, "not_found", "No such verdict.");
      if (verdict.execution?.status !== "pending_owner") {
        throw new ServiceError(409, "not_pending", "This payment isn't waiting for a decision.");
      }
      const approval = ledger.approvalFor(verdictId);
      if (!approval || approval.usedAt || !sameHash(approval.tokenHash, hashToken(token))) {
        throw new ServiceError(401, "invalid_token", "That approval link isn't valid.");
      }
      // Checked before the token is spent, so the owner can approve after unfreezing.
      if (action === "approve" && this.isFrozen()) {
        throw new ServiceError(409, "frozen", "Payments are frozen. Unfreeze them to approve this one.");
      }

      const at = this.now().toISOString();
      ledger.saveApproval({ ...approval, usedAt: at });
      this.deps.audit.append({ type: "owner_action", at, verdictId, action });
      if (action === "reject") {
        return this.setExecution(verdict, { status: "refused", provider: this.providerName, note: OWNER_REJECTED_NOTE });
      }

      // Time has passed since the HOLD, so the owner's hard limits are checked again.
      const record = ledger.requestRecord(verdict.requestId);
      const broken = policySignals(
        {
          requestId: verdict.requestId,
          agentId: record?.agentId ?? "unknown",
          ownerId: this.deps.fleetOwnerId,
          payee: verdict.payee,
          chain: verdict.chain,
          asset: verdict.asset,
          amount: verdict.amount,
          purpose: "",
          createdAt: verdict.createdAt,
        },
        this.currentPolicy(),
        ledger.snapshot(this.deps.fleetOwnerId),
        this.now(),
        true,
      ).find((signal) => (SIGNALS[signal.code as SignalCode] as { forces?: string }).forces === "block");
      if (broken) {
        return this.setExecution(verdict, { status: "refused", provider: this.providerName, note: broken.message });
      }
      return this.execute(verdict);
    });
  }

  /** A held payment nobody answered in time doesn't stay open forever. */
  expireHolds(): void {
    const now = this.now();
    for (const approval of this.deps.ledger.openApprovals()) {
      if (Date.parse(approval.expiresAt) > now.getTime()) continue;
      this.deps.ledger.saveApproval({ ...approval, usedAt: now.toISOString() });
      const verdict = this.deps.ledger.verdictById(approval.verdictId);
      if (verdict?.execution?.status === "pending_owner") {
        this.setExecution(verdict, { status: "refused", provider: this.providerName, note: "Nobody decided in time, so it wasn't paid." });
      }
    }
  }

  /** Payments waiting for the owner, without their tokens. */
  pendingHolds(): { verdict: Verdict; expiresAt: string }[] {
    this.expireHolds();
    return this.deps.ledger.openApprovals().flatMap((approval) => {
      const verdict = this.deps.ledger.verdictById(approval.verdictId);
      return verdict ? [{ verdict, expiresAt: approval.expiresAt }] : [];
    });
  }

  /** So an agent told HOLD can find out what the owner decided, instead of waiting forever or trying again. */
  paymentStatus(verdictId: string): PaymentStatus | undefined {
    this.expireHolds();
    const verdict = this.deps.ledger.verdictById(verdictId);
    if (!verdict || verdict.mode !== "pay") return undefined;
    const { decision, execution } = verdict;
    const pending = execution?.status === "pending_owner";
    const decideBy = pending ? this.deps.ledger.approvalFor(verdictId)?.expiresAt : undefined;
    return {
      verdictId,
      decision,
      paid: execution?.status === "executed",
      status: execution?.status ?? null,
      nextStep: nextStepFor(verdict),
      ...(execution?.txHash ? { txHash: execution.txHash } : {}),
      ...(decideBy ? { decideBy } : {}),
    };
  }

  /**
   * What the owner sees before deciding. The one-time token is what lets them read it, because a phone opening a link
   * has no other credential. It stays valid for reading once used, so a reload shows what was decided.
   */
  previewHold(verdictId: string, token: string): { verdict: VerdictView; expiresAt: string; open: boolean } {
    this.expireHolds();
    const { ledger } = this.deps;
    const approval = ledger.approvalFor(verdictId);
    const verdict = ledger.verdictById(verdictId);
    if (!approval || !verdict || !sameHash(approval.tokenHash, hashToken(token))) {
      throw new ServiceError(401, "invalid_token", "That approval link isn't valid.");
    }
    return { verdict: this.view(verdict), expiresAt: approval.expiresAt, open: verdict.execution?.status === "pending_owner" };
  }

  /** A fresh link for a pending payment, in case the first was lost. The old one stops working. */
  renewApprovalLink(verdictId: string): { approvalUrl: string; expiresAt: string } {
    this.expireHolds();
    const approval = this.deps.ledger.approvalFor(verdictId);
    if (!approval || approval.usedAt) throw new ServiceError(404, "not_found", "No payment is waiting on that id.");
    return { approvalUrl: this.issueApproval(verdictId, approval.expiresAt), expiresAt: approval.expiresAt };
  }

  /** Records a report published after the verdict was made. It's outside the signature, as `networkReportId` always is. */
  markReported(verdictId: string, reportId: string): void {
    const verdict = this.deps.ledger.verdictById(verdictId);
    if (!verdict) return;
    const reported: Verdict = { ...verdict, networkReportId: reportId };
    this.deps.ledger.saveVerdict(reported);
    this.emit("verdict", reported);
  }

  /** Checks the whole audit chain and every signature in it, then returns the latest records. */
  async auditReport(limit: number, verdictId?: string) {
    const lines = this.deps.audit.lines();
    const report = await verifyAuditLines(lines, await this.publicKey());
    const records = lines.map((line) => JSON.parse(line) as AuditRecord);
    const subject = (entry: AuditEntry) => (entry.type === "verdict" ? entry.verdict.verdictId : "verdictId" in entry ? entry.verdictId : undefined);
    const about = verdictId ? records.filter(({ entry }) => subject(entry) === verdictId) : records;
    return { ...report, records: about.slice(-limit).reverse() };
  }

  /** Stops all spending at once. Wardy Agent is the only spender, so nothing else can move funds. */
  freeze(): void {
    this.setFrozen(true);
  }

  unfreeze(): void {
    this.setFrozen(false);
  }

  private setFrozen(frozen: boolean) {
    if (this.deps.ledger.isFrozen() !== frozen) {
      this.deps.ledger.setFrozen(frozen);
      this.deps.audit.append({ type: frozen ? "freeze" : "unfreeze", at: this.now().toISOString() });
    }
    this.emit("frozen", frozen);
  }

  /** Dashboard numbers, all computed from real verdicts. Nothing here is a constant. */
  stats() {
    const day = this.now().toISOString().slice(0, 10);
    const verdicts = this.deps.ledger.allVerdicts();
    const today = verdicts.filter((verdict) => verdict.createdAt.startsWith(day));
    const saved = new Map<string, bigint>();
    for (const verdict of verdicts) {
      if (verdict.mode !== "pay" || !isScamStopped(verdict)) continue;
      saved.set(verdict.asset, (saved.get(verdict.asset) ?? 0n) + parseDecimal(verdict.amount));
    }
    return {
      checkedToday: today.length,
      blockedToday: today.filter((verdict) => verdict.decision === "BLOCK").length,
      heldNow: verdicts.filter((verdict) => verdict.execution?.status === "pending_owner").length,
      paidToday: today.filter((verdict) => verdict.execution?.status === "executed").length,
      saved: [...saved].map(([asset, amount]) => ({ asset, amount: formatDecimal(amount) })),
      checksForOthers: verdicts.filter((verdict) => verdict.mode === "check").length,
    };
  }
}

/** A BLOCK or rejection counts as saved money only if something looked like an attack, not just a limit. */
function isScamStopped(verdict: Verdict): boolean {
  const stopped = verdict.decision === "BLOCK" || verdict.execution?.note === OWNER_REJECTED_NOTE;
  return stopped && verdict.signals.some((signal) => signal.detector !== "policy" && signal.points > 0);
}
