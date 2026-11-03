// D6 unusual amount. Limits are one number for every payee, so they can't see an API that charges 0.01 suddenly
// asking for 2.5. This compares a payment with what this owner has really paid this payee, in this asset. It only ever
// asks the owner: a big payment to a real payee can be honest, like a yearly renewal.
import { makeSignal, THRESHOLDS } from "../config.js";
import { formatDecimal, parseDecimal } from "../decimal.js";
import { type LedgerSnapshot, samePayee } from "../ledger.js";
import type { PaymentRequest, Signal } from "../types.js";

/** The middle amount, so one large payment can't shift what counts as usual. */
function medianOf(sorted: readonly bigint[]): bigint {
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] as bigint;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] as bigint) + upper) / 2n;
}

export function unusualAmountSignals(request: Pick<PaymentRequest, "payee" | "chain" | "asset" | "amount">, ledger: LedgerSnapshot): Signal[] {
  const paid = ledger.settled
    // A payment custody couldn't confirm counts against a retry, but it isn't proof of what's normal.
    .filter((payment) => samePayee(payment, request) && payment.asset === request.asset && !payment.uncertain)
    .map((payment) => parseDecimal(payment.amount))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (paid.length < THRESHOLDS.unusualAmountMinPayments) return [];

  const amount = parseDecimal(request.amount);
  const usual = medianOf(paid);
  const highest = paid.at(-1) as bigint;
  const small = amount < parseDecimal(THRESHOLDS.unusualAmountIgnoreBelow);
  // Paid this much before means the owner has seen it. A median of zero can't be multiplied, so it never counts as usual.
  if (small || usual === 0n || amount <= highest || amount <= usual * BigInt(THRESHOLDS.unusualAmountMultiple)) return [];

  const times = amount / usual;
  return [
    makeSignal("AMOUNT_UNUSUAL_FOR_PAYEE", `This payee usually gets about ${formatDecimal(usual)}. This asks for ${request.amount}, about ${times} times as much.`, {
      usual: formatDecimal(usual),
      highest: formatDecimal(highest),
      paidCount: paid.length,
      amount: request.amount,
    }),
  ];
}
