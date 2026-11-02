import { randomUUID } from "node:crypto";
import { WNEAR_ASSET } from "../src/assets.js";
import type { SettledPayment } from "../src/ledger.js";
import type { PaymentRequest, Verdict } from "../src/types.js";

export const NOW = new Date("2026-11-05T12:00:00.000Z");
export const OWNER = "owner.near";

export function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

export function makeRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    requestId: randomUUID(),
    agentId: "procure-bot",
    ownerId: OWNER,
    payee: "acme-shop.near",
    chain: "near",
    asset: WNEAR_ASSET,
    amount: "2",
    purpose: "office supplies",
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

export function makeSettled(overrides: Partial<SettledPayment> = {}): SettledPayment {
  return {
    requestId: randomUUID(),
    ownerId: OWNER,
    payee: "acme-shop.near",
    chain: "near",
    asset: WNEAR_ASSET,
    amount: "2",
    settledAt: minutesAgo(5),
    txHash: "txhash1234567890",
    ...overrides,
  };
}

export function makeUnsignedVerdict(overrides: Partial<Verdict> = {}): Omit<Verdict, "signature" | "wardyPublicKey"> {
  return {
    verdictId: randomUUID(),
    requestId: randomUUID(),
    requestHash: "a".repeat(64),
    payee: "acme-shop.near",
    chain: "near",
    asset: WNEAR_ASSET,
    amount: "2",
    decision: "ALLOW",
    riskScore: 0,
    signals: [],
    reasons: ["No risk signals found."],
    ai: { used: false, attested: false },
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}
