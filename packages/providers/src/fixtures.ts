import { randomUUID } from "node:crypto";
import { type Ledger, normalizeAsset } from "@wardy-agent/core";
import accounts from "../fixtures/accounts.json" with { type: "json" };
import findings from "../fixtures/ai-findings.json" with { type: "json" };
import history from "../fixtures/history.json" with { type: "json" };
import type { RecordedFinding } from "./ai/mock.js";
import type { MockAccount } from "./chain/mock.js";

/** Offline chain data. Every name is checked by `npm run check:fixtures` to be unregistered on mainnet. */
export const OFFLINE_ACCOUNTS: Readonly<Record<string, MockAccount>> = accounts;

/**
 * Answers recorded from real NEAR AI Cloud runs by `npm run attack-lab -- --record`. Empty until that has run:
 * offline demos then say the AI didn't run, rather than showing made-up answers.
 */
export const RECORDED_AI_FINDINGS = findings as unknown as Readonly<Record<string, RecordedFinding>>;

/** Gives the demo owner a real-looking past: payees paid before, so a lookalike has someone to imitate. */
export function seedOfflineHistory(ledger: Ledger, ownerId: string, now: Date, newId: () => string = randomUUID) {
  for (const { payee, asset, amount, daysAgo, invoiceId } of history) {
    ledger.recordSettled({
      requestId: newId(),
      ownerId,
      payee,
      chain: "near",
      asset: normalizeAsset(asset),
      amount,
      settledAt: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(),
      txHash: `mock-history-${payee}-${daysAgo}`,
      ...(invoiceId ? { invoiceId } : {}),
    });
  }
}
