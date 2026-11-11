// Every threshold and score lives here, so the rules can be read in one place and are tested as a table.
import type { Detector, Severity, Signal } from "./types.js";

export const THRESHOLDS = {
  blockScore: 60,
  holdScore: 30,
  veryNewAccountHours: 24,
  newAccountDays: 7,
  lowActivityTxCount: 3,
  duplicateWindowMinutes: 15,
  /** How recently a settled payment makes "payment failed, send again" suspicious. */
  retryRecentHours: 24,
  velocityWindowMinutes: 10,
  velocityMinRequests: 3,
  dailyBudgetWindowHours: 24,
  /** Fewer payments than this don't show what's usual, so the amount check says nothing. */
  unusualAmountMinPayments: 3,
  /** "Far more than usual": ordinary invoices from one payee easily vary by double. */
  unusualAmountMultiple: 3,
  /** With fewer payments than the minimum there's less to go on, so a smaller jump is enough to ask. */
  unusualAmountThinHistoryMultiple: 2,
  /** In asset units, like the owner's limits. Not worth interrupting anyone below this. */
  unusualAmountIgnoreBelow: "0.5",
  /** Shorter names need a closer match, or `bishop.near` would look like `shop.near`. */
  editDistanceMinLength: 4,
  editDistanceLongNameLength: 6,
  editDistanceShort: 1,
  editDistanceLong: 2,
  /** A paid payee's whole name inside another name counts only from this length, so a short name can't flag everyone. */
  wrappedNameMinLength: 6,
  /** Below this, an AI finding is ignored. That can only ever mean less added risk, never less existing risk. */
  aiMinConfidence: 0.5,
} as const;

export type Forces = "block" | "hold";

export interface SignalDef {
  detector: Detector;
  severity: Severity;
  points: number;
  forces?: Forces;
}

export const SIGNALS = {
  // D1: lookalike payee
  LOOKALIKE_HOMOGLYPH: { detector: "lookalike", severity: "critical", points: 60 },
  LOOKALIKE_EDIT_DISTANCE: { detector: "lookalike", severity: "high", points: 40 },
  LOOKALIKE_SUFFIX_TRICK: { detector: "lookalike", severity: "high", points: 40 },
  KNOWN_PAYEE: { detector: "lookalike", severity: "info", points: -10 },

  // D2: new-account risk
  ACCOUNT_NOT_FOUND: { detector: "new_account", severity: "critical", points: 70 },
  IMPLICIT_ACCOUNT_UNFUNDED: { detector: "new_account", severity: "medium", points: 20 },
  ACCOUNT_VERY_NEW: { detector: "new_account", severity: "high", points: 30 },
  ACCOUNT_NEW: { detector: "new_account", severity: "medium", points: 15 },
  ACCOUNT_LOW_ACTIVITY: { detector: "new_account", severity: "low", points: 10 },
  ACCOUNT_DATA_UNAVAILABLE: { detector: "new_account", severity: "low", points: 5 },

  // D3: duplicate and retry
  DUPLICATE_INVOICE: { detector: "duplicate", severity: "critical", points: 70 },
  DUPLICATE_PAYMENT_WINDOW: { detector: "duplicate", severity: "high", points: 45 },
  // Forces HOLD, which goes beyond the brief: without it, a retry after the 15-minute window on a known
  // payee scores 10 and would be paid. That's the exact double payment this product exists to stop.
  RETRY_PRESSURE: { detector: "duplicate", severity: "medium", points: 20, forces: "hold" },
  VELOCITY_NEW_PAYEE: { detector: "duplicate", severity: "high", points: 40 },

  // D4: context tamper
  CONTEXT_PAYEE_CHANGE: { detector: "context_tamper", severity: "high", points: 35 },
  CONTEXT_BYPASS_ATTEMPT: { detector: "context_tamper", severity: "critical", points: 50 },
  CONTEXT_URGENCY: { detector: "context_tamper", severity: "low", points: 10 },
  CONTEXT_PAYEE_MISMATCH: { detector: "context_tamper", severity: "high", points: 40 },
  // Forces HOLD: without it, a real payee's inflated bill scores 25 and is paid, even with the mismatch spotted.
  CONTEXT_AMOUNT_MISMATCH: { detector: "context_tamper", severity: "high", points: 35, forces: "hold" },
  AI_UNAVAILABLE: { detector: "context_tamper", severity: "info", points: 0 },

  // D5: cross-chain destination
  CHAIN_ADDRESS_MISMATCH: { detector: "cross_chain", severity: "critical", points: 60 },
  CHAIN_NOT_CHECKED: { detector: "cross_chain", severity: "low", points: 10 },

  // D6: unusual amount. Forces HOLD and never BLOCK: only the owner knows if this one's real.
  AMOUNT_UNUSUAL_FOR_PAYEE: { detector: "amount", severity: "medium", points: 20, forces: "hold" },
  AMOUNT_UNUSUAL_DAY_FOR_PAYEE: { detector: "amount", severity: "medium", points: 20, forces: "hold" },
  AMOUNT_FIRST_IN_THIS_ASSET: { detector: "amount", severity: "medium", points: 15, forces: "hold" },
  AMOUNT_HIGH_FOR_LITTLE_HISTORY: { detector: "amount", severity: "medium", points: 15, forces: "hold" },

  // Wardy Network
  NETWORK_REPORTED_SCAM: { detector: "network", severity: "critical", points: 80 },
  NETWORK_REPORTED_LOOKALIKE_OF_YOUR_PAYEE: { detector: "network", severity: "critical", points: 10 },

  // Owner policy. The forced ones decide on their own, so their points only rank them among the reasons.
  POLICY_OVER_PER_PAYMENT_LIMIT: { detector: "policy", severity: "critical", points: 50, forces: "block" },
  POLICY_OVER_DAILY_BUDGET: { detector: "policy", severity: "critical", points: 50, forces: "block" },
  POLICY_ASSET_NOT_ALLOWED: { detector: "policy", severity: "critical", points: 50, forces: "block" },
  POLICY_FROZEN: { detector: "policy", severity: "critical", points: 50, forces: "block" },
  POLICY_NEW_PAYEE_REQUIRES_APPROVAL: { detector: "policy", severity: "medium", points: 15, forces: "hold" },
  POLICY_ABOVE_APPROVAL_THRESHOLD: { detector: "policy", severity: "medium", points: 15, forces: "hold" },
} as const satisfies Record<string, SignalDef>;

export type SignalCode = keyof typeof SIGNALS;

export function makeSignal(code: SignalCode, message: string, evidence: Record<string, unknown> = {}): Signal {
  const { detector, severity, points } = SIGNALS[code];
  return { detector, code, severity, points, message, evidence };
}

/** Plain time for owners: 42s, 3m, 2h, 5d. */
export function formatAgo(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole}s`;
  if (whole < 3600) return `${Math.floor(whole / 60)}m`;
  if (whole < 86_400) return `${Math.floor(whole / 3600)}h`;
  return `${Math.floor(whole / 86_400)}d`;
}
