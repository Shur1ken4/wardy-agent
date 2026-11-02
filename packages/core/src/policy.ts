// The owner's rules. In live mode the custody provider enforces its own copy of the limits as well, so these
// are a second lock, not the only one.
import { z } from "zod";
import { USDC_ASSET, WNEAR_ASSET } from "./assets.js";
import { makeSignal, THRESHOLDS } from "./config.js";
import { formatDecimal, parseDecimal } from "./decimal.js";
import type { LedgerSnapshot } from "./ledger.js";
import { AmountSchema, type PaymentRequest, type Signal } from "./types.js";

export const OwnerPolicySchema = z.strictObject({
  /** In asset units, per asset. */
  maxPerPayment: AmountSchema,
  dailyBudget: AmountSchema,
  /** Above this, the owner decides. */
  approvalThreshold: AmountSchema,
  allowedAssets: z.array(z.string().min(1)).min(1),
  askForNewPayees: z.boolean(),
  frozen: z.boolean(),
  // Literal on purpose: the docs say native transfers skip destinations, budget and owner approval.
  nativeNearTransfers: z.literal(false),
});

export type OwnerPolicy = z.output<typeof OwnerPolicySchema>;

export const DEFAULT_POLICY: OwnerPolicy = {
  maxPerPayment: "5",
  dailyBudget: "40",
  approvalThreshold: "3",
  allowedAssets: [WNEAR_ASSET, USDC_ASSET],
  askForNewPayees: true,
  frozen: false,
  nativeNearTransfers: false,
};

export function policySignals(
  request: PaymentRequest,
  policy: OwnerPolicy,
  ledger: LedgerSnapshot,
  now: Date,
  payeeIsKnown: boolean,
): Signal[] {
  const signals: Signal[] = [];
  if (policy.frozen) {
    signals.push(makeSignal("POLICY_FROZEN", "Payments are frozen. Unfreeze them to continue."));
  }
  if (!policy.allowedAssets.includes(request.asset)) {
    signals.push(makeSignal("POLICY_ASSET_NOT_ALLOWED", "Your rules don't allow paying with this asset.", { asset: request.asset }));
  }

  const amount = parseDecimal(request.amount);
  if (amount > parseDecimal(policy.maxPerPayment)) {
    signals.push(
      makeSignal("POLICY_OVER_PER_PAYMENT_LIMIT", `This is over your limit of ${policy.maxPerPayment} per payment.`, {
        limit: policy.maxPerPayment,
        amount: request.amount,
      }),
    );
  }

  const windowStart = now.getTime() - THRESHOLDS.dailyBudgetWindowHours * 3_600_000;
  const spent = ledger.settled
    .filter((payment) => payment.asset === request.asset && Date.parse(payment.settledAt) >= windowStart)
    .reduce((total, payment) => total + parseDecimal(payment.amount), 0n);
  if (spent + amount > parseDecimal(policy.dailyBudget)) {
    signals.push(
      makeSignal("POLICY_OVER_DAILY_BUDGET", `This would pass your budget of ${policy.dailyBudget} a day.`, {
        budget: policy.dailyBudget,
        spentToday: formatDecimal(spent),
        amount: request.amount,
      }),
    );
  }

  if (policy.askForNewPayees && !payeeIsKnown) {
    signals.push(makeSignal("POLICY_NEW_PAYEE_REQUIRES_APPROVAL", "You asked to approve payees you haven't paid before."));
  }
  if (amount > parseDecimal(policy.approvalThreshold)) {
    signals.push(
      makeSignal("POLICY_ABOVE_APPROVAL_THRESHOLD", `You asked to approve payments above ${policy.approvalThreshold}.`, {
        threshold: policy.approvalThreshold,
        amount: request.amount,
      }),
    );
  }
  return signals;
}
