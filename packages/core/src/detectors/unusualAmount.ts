// D6 unusual amount. Limits are one number for every payee, so they can't see an API that charges 0.01 suddenly
// asking for 2.5. This compares a payment with what this owner has really paid this payee, in this asset. It only ever
// asks the owner: a big payment to a real payee can be honest, like a yearly renewal.
import { makeSignal, THRESHOLDS } from "../config.js";
import { formatDecimal, parseDecimal } from "../decimal.js";
import { type LedgerSnapshot, samePayee, type SettledPayment } from "../ledger.js";
import type { PaymentRequest, Signal } from "../types.js";

const DAY_MS = THRESHOLDS.dailyBudgetWindowHours * 3_600_000;

/** The middle amount, so one large payment can't shift what counts as usual. */
function medianOf(sorted: readonly bigint[]): bigint {
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] as bigint;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] as bigint) + upper) / 2n;
}

function total(payments: readonly SettledPayment[]): bigint {
  return payments.reduce((sum, payment) => sum + parseDecimal(payment.amount), 0n);
}

/** The most this payee received in any 24 hours that ended before `before`. */
function busiestEarlierDay(payments: readonly SettledPayment[], before: number): bigint {
  const times = payments.map((payment) => Date.parse(payment.settledAt));
  let busiest = 0n;
  for (const end of times) {
    if (end >= before) continue;
    const inWindow = payments.filter((_payment, index) => (times[index] as number) <= end && (times[index] as number) > end - DAY_MS);
    const sum = total(inWindow);
    if (sum > busiest) busiest = sum;
  }
  return busiest;
}

export function unusualAmountSignals(request: Pick<PaymentRequest, "payee" | "chain" | "asset" | "amount">, ledger: LedgerSnapshot, now: Date): Signal[] {
  const toPayee = ledger.settled.filter((payment) => samePayee(payment, request));
  // Never paid at all: the new-payee rule already asks, and there's nothing here to compare with.
  if (toPayee.length === 0) return [];

  const amount = parseDecimal(request.amount);
  const small = amount < parseDecimal(THRESHOLDS.unusualAmountIgnoreBelow);
  const inAsset = toPayee.filter((payment) => payment.asset === request.asset);
  // A payment custody couldn't confirm counts against a retry, but it isn't proof of what's normal.
  const confirmed = inAsset.filter((payment) => !payment.uncertain);
  const paid = confirmed.map((payment) => parseDecimal(payment.amount)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const highest = paid.at(-1) ?? 0n;

  if (inAsset.length === 0) {
    if (small) return [];
    return [makeSignal("AMOUNT_FIRST_IN_THIS_ASSET", "You've paid this payee before, but never in this asset.", { amount: request.amount, paidCount: toPayee.length })];
  }

  if (paid.length < THRESHOLDS.unusualAmountMinPayments) {
    if (small || paid.length === 0 || amount <= highest * BigInt(THRESHOLDS.unusualAmountThinHistoryMultiple)) return [];
    return [
      makeSignal("AMOUNT_HIGH_FOR_LITTLE_HISTORY", `You've paid this payee only ${paid.length === 1 ? "once" : `${paid.length} times`}, and this is more than double the most they've had.`, {
        highest: formatDecimal(highest),
        paidCount: paid.length,
        amount: request.amount,
      }),
    ];
  }

  const usual = medianOf(paid);
  // Paid this much before means the owner has seen it. A median of zero can't be multiplied, so it never counts as usual.
  if (!small && usual > 0n && amount > highest && amount > usual * BigInt(THRESHOLDS.unusualAmountMultiple)) {
    return [
      makeSignal("AMOUNT_UNUSUAL_FOR_PAYEE", `This payee usually gets about ${formatDecimal(usual)}. This asks for ${request.amount}, about ${amount / usual} times as much.`, {
        usual: formatDecimal(usual),
        highest: formatDecimal(highest),
        paidCount: paid.length,
        amount: request.amount,
      }),
    ];
  }

  // Many ordinary payments can add up to what one big one would. The busiest earlier day is the yardstick, so an API
  // that's called all day doesn't trip it. Every payment counts here, confirmed or not: it may really have gone out.
  const windowStart = now.getTime() - DAY_MS;
  const today = total(inAsset.filter((payment) => Date.parse(payment.settledAt) >= windowStart)) + amount;
  const busiest = busiestEarlierDay(confirmed, windowStart);
  if (busiest === 0n || today < parseDecimal(THRESHOLDS.unusualAmountIgnoreBelow) || today <= busiest * BigInt(THRESHOLDS.unusualAmountMultiple)) return [];
  return [
    makeSignal("AMOUNT_UNUSUAL_DAY_FOR_PAYEE", `This would make ${formatDecimal(today)} to this payee in 24 hours. Their busiest day before was ${formatDecimal(busiest)}.`, {
      today: formatDecimal(today),
      busiest: formatDecimal(busiest),
      amount: request.amount,
    }),
  ];
}
