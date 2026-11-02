import { type SignalCode, SIGNALS, THRESHOLDS } from "./config.js";
import type { Decision, Signal } from "./types.js";

export interface DecisionOutcome {
  decision: Decision;
  riskScore: number;
  reasons: string[];
  /** Which rule decided, 1 to 5, in the order below. */
  rule: 1 | 2 | 3 | 4 | 5;
}

const OTHER_DETECTORS = new Set(["lookalike", "new_account", "context_tamper", "cross_chain", "network"]);
const SERIOUS = new Set(["high", "critical"]);

function forces(signal: Signal, what: "block" | "hold"): boolean {
  const def = SIGNALS[signal.code as SignalCode] as { forces?: string } | undefined;
  return def?.forces === what;
}

/** The top three by points. `first` is for rule 2, where the owner has a specific question to answer. */
function topReasons(signals: Signal[], first?: Signal): string[] {
  const ranked = signals.filter((signal) => signal.points > 0 && signal !== first).sort((a, b) => b.points - a.points);
  const reasons = [...(first ? [first] : []), ...ranked].slice(0, 3).map((signal) => signal.message);
  if (reasons.length > 0) return reasons;
  const reassuring = signals.find((signal) => signal.code === "KNOWN_PAYEE");
  return [reassuring?.message ?? "No risk signals found."];
}

/** The rules apply in exactly this order. Deterministic: the AI can add signals, but never decides. */
export function decide(signals: Signal[]): DecisionOutcome {
  const total = signals.reduce((sum, signal) => sum + signal.points, 0);
  const riskScore = Math.min(100, Math.max(0, total));
  const outcome = (decision: Decision, rule: DecisionOutcome["rule"], first?: Signal): DecisionOutcome => ({
    decision,
    riskScore,
    reasons: topReasons(signals, first),
    rule,
  });

  // 1. A broken owner rule ends it.
  const blockingPolicy = signals.find((signal) => signal.detector === "policy" && forces(signal, "block"));
  if (blockingPolicy) return outcome("BLOCK", 1);

  // 2. A duplicate to a payee you really do pay, and nothing else wrong: the payee is legitimate and you may
  // truly want to pay twice, so it's your call.
  const duplicate = signals.find((signal) => signal.code === "DUPLICATE_INVOICE" || signal.code === "DUPLICATE_PAYMENT_WINDOW");
  const isKnown = signals.some((signal) => signal.code === "KNOWN_PAYEE");
  const otherTrouble = signals.some((signal) => OTHER_DETECTORS.has(signal.detector) && SERIOUS.has(signal.severity));
  if (duplicate && isKnown && !otherTrouble) return outcome("HOLD", 2, duplicate);

  // 3. Anything critical, from any detector or the Network.
  if (signals.some((signal) => signal.severity === "critical")) return outcome("BLOCK", 3);

  // 4. The score.
  if (riskScore >= THRESHOLDS.blockScore) return outcome("BLOCK", 4);
  if (riskScore >= THRESHOLDS.holdScore) return outcome("HOLD", 4);

  // 5. A rule that asks for the owner lifts ALLOW to HOLD.
  if (signals.some((signal) => forces(signal, "hold"))) return outcome("HOLD", 5);
  return outcome("ALLOW", 4);
}
