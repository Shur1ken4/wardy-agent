// D2. A scammer's account is usually hours old with no history. Only NEAR accounts have this data here; for
// other chains this stays silent rather than guessing.
import { formatAgo, makeSignal, THRESHOLDS } from "../config.js";
import type { AccountFacts, Chain, Signal } from "../types.js";

const HOUR_MS = 3_600_000;

export function newAccountSignals(request: { payee: string; chain: Chain }, facts: AccountFacts | null, now: Date): Signal[] {
  if (request.chain !== "near") return [];
  if (!facts || !facts.available) {
    return [makeSignal("ACCOUNT_DATA_UNAVAILABLE", "Couldn't check this account's history right now.", { field: "existence" })];
  }
  if (!facts.exists) {
    if (facts.implicit) {
      return [makeSignal("IMPLICIT_ACCOUNT_UNFUNDED", "This account has never been funded, so it has no history.")];
    }
    return [makeSignal("ACCOUNT_NOT_FOUND", "This account doesn't exist on NEAR.")];
  }

  const signals: Signal[] = [];
  if (facts.createdAt === null) {
    signals.push(makeSignal("ACCOUNT_DATA_UNAVAILABLE", "Couldn't check this account's age right now.", { field: "createdAt" }));
  } else {
    const ageMs = now.getTime() - Date.parse(facts.createdAt);
    const age = formatAgo(ageMs / 1000);
    const evidence = { createdAt: facts.createdAt, ageHours: Math.floor(ageMs / HOUR_MS) };
    if (ageMs < THRESHOLDS.veryNewAccountHours * HOUR_MS) {
      signals.push(makeSignal("ACCOUNT_VERY_NEW", `This account was created only ${age} ago.`, evidence));
    } else if (ageMs < THRESHOLDS.newAccountDays * 24 * HOUR_MS) {
      signals.push(makeSignal("ACCOUNT_NEW", `This account is only ${age} old.`, evidence));
    }
  }
  if (facts.txCount !== null && facts.txCount < THRESHOLDS.lowActivityTxCount) {
    signals.push(
      makeSignal("ACCOUNT_LOW_ACTIVITY", `This account has made only ${facts.txCount} transaction${facts.txCount === 1 ? "" : "s"}.`, {
        txCount: facts.txCount,
      }),
    );
  }
  return signals;
}
