// D3. The leak limits and allowlists leave open: a second payment to the right merchant, usually after a fake
// "payment failed, please retry". Agents retry because they believe the first payment failed, so the check has
// to come from the record of what actually settled.
import { formatAgo, makeSignal, THRESHOLDS } from "../config.js";
import { parseDecimal } from "../decimal.js";
import { sha256Hex } from "../hash.js";
import { type LedgerSnapshot, samePayee, type SettledPayment } from "../ledger.js";
import { foldText } from "../text.js";
import type { PaymentRequest, Signal } from "../types.js";

const MINUTE_MS = 60_000;

const RETRY_PATTERNS = [
  /\b(?:payment|transfer|transaction)\s+(?:has\s+|was\s+|did\s+)?(?:failed|fail|declined|rejected|reverted|not\s+(?:go\s+through|received|complete[d]?))\b/i,
  /\bnothing\s+was\s+charged\b/i,
  /\b(?:was\s+|were\s+)?not\s+charged\b/i,
  /\b(?:send|pay|transfer)\s+(?:it\s+|that\s+|this\s+|the\s+\w+\s+)?again\b/i,
  /\bretry\s+(?:the\s+|your\s+)?(?:payment|transfer|transaction)\b/i,
  /\bresend\s+(?:the\s+|your\s+)?(?:payment|funds|transfer)\b/i,
  /\bdid\s*n[o']?t?\s+(?:go\s+through|arrive)\b/i,
  /\b(?:never|not)\s+(?:arrived|received\s+(?:your|the)\s+(?:payment|funds|transfer))\b/i,
];

/** Two copies of an invoice that differ only in spacing, case or invisible characters are the same invoice. */
export function invoiceTextHash(text: string): string {
  return sha256Hex(foldText(text).replace(/\s+/g, " ").trim());
}

export function claimsPaymentFailed(request: PaymentRequest): boolean {
  const texts = [request.context?.toolResultText, request.context?.emailText, request.context?.invoiceText];
  return texts.some((text) => text !== undefined && RETRY_PATTERNS.some((pattern) => pattern.test(foldText(text))));
}

function settledEvidence(payment: SettledPayment, now: Date) {
  const secondsAgo = Math.floor((now.getTime() - Date.parse(payment.settledAt)) / 1000);
  return { settledAt: payment.settledAt, secondsAgo, txHash: payment.txHash ?? null, requestId: payment.requestId };
}

function shortTx(payment: SettledPayment): string {
  return payment.txHash ? ` (tx ${payment.txHash.slice(0, 10)}…)` : "";
}

export function duplicateSignals(
  request: PaymentRequest,
  ledger: LedgerSnapshot,
  now: Date,
  options: { aiClaimsPaymentFailed?: boolean } = {},
): Signal[] {
  const signals: Signal[] = [];
  const ago = (payment: SettledPayment) => formatAgo((now.getTime() - Date.parse(payment.settledAt)) / 1000);
  const toThisPayee = ledger.settled.filter((payment) => samePayee(payment, request));

  // An invoice number is only unique per merchant. The full text isn't: the same document re-sent with a
  // different payee is exactly what a swapped-address attack looks like.
  const invoiceHash = request.context?.invoiceText ? invoiceTextHash(request.context.invoiceText) : undefined;
  const byId = request.invoiceId ? toThisPayee.find((payment) => payment.invoiceId === request.invoiceId) : undefined;
  const byText = invoiceHash ? ledger.settled.find((payment) => payment.invoiceTextHash === invoiceHash) : undefined;
  const sameInvoice = byId ?? byText;
  if (sameInvoice) {
    signals.push(
      makeSignal("DUPLICATE_INVOICE", `This invoice was already paid ${ago(sameInvoice)} ago${shortTx(sameInvoice)}. Pay again?`, {
        ...settledEvidence(sameInvoice, now),
        matchedOn: byId ? "invoiceId" : "invoiceText",
      }),
    );
  }

  const windowStart = now.getTime() - THRESHOLDS.duplicateWindowMinutes * MINUTE_MS;
  const retried = claimsPaymentFailed(request) || Boolean(options.aiClaimsPaymentFailed);
  const sameAmount = toThisPayee.find(
    (payment) =>
      payment.asset === request.asset &&
      parseDecimal(payment.amount) === parseDecimal(request.amount) &&
      Date.parse(payment.settledAt) >= windowStart &&
      // An API that charges the same price for every call sends a new bill each time. Two payments that each carry
      // their own, different invoice id are two bills, unless something says the first one failed.
      !(request.invoiceId && payment.invoiceId && payment.invoiceId !== request.invoiceId && !retried),
  );
  if (sameAmount) {
    signals.push(
      makeSignal("DUPLICATE_PAYMENT_WINDOW", `Identical payment settled ${ago(sameAmount)} ago${shortTx(sameAmount)}. Pay again?`, settledEvidence(sameAmount, now)),
    );
  }

  const recentStart = now.getTime() - THRESHOLDS.retryRecentHours * 60 * MINUTE_MS;
  const recent = toThisPayee.find((payment) => Date.parse(payment.settledAt) >= recentStart);
  if (recent && retried) {
    signals.push(
      makeSignal("RETRY_PRESSURE", `The agent read that a payment failed, but one to this payee settled ${ago(recent)} ago${shortTx(recent)}.`, settledEvidence(recent, now)),
    );
  }

  // Splitting one theft into small payments keeps each under the limits.
  const everPaid = toThisPayee.length > 0;
  if (!everPaid) {
    const velocityStart = now.getTime() - THRESHOLDS.velocityWindowMinutes * MINUTE_MS;
    const earlier = ledger.requests.filter(
      (record) => samePayee(record, request) && record.requestId !== request.requestId && Date.parse(record.createdAt) >= velocityStart,
    );
    const total = earlier.length + 1;
    if (total >= THRESHOLDS.velocityMinRequests) {
      signals.push(
        makeSignal("VELOCITY_NEW_PAYEE", `${total} payment requests to a payee you've never paid, in ${THRESHOLDS.velocityWindowMinutes} minutes.`, {
          requestsInWindow: total,
          windowMinutes: THRESHOLDS.velocityWindowMinutes,
        }),
      );
    }
  }
  return signals;
}
