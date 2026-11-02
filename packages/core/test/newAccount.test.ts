import { describe, expect, it } from "vitest";
import { newAccountSignals } from "../src/detectors/newAccount.js";
import type { AccountFacts } from "../src/types.js";
import { NOW } from "./helpers.js";

const NAMED = { payee: "acme-shop.near", chain: "near" };

function facts(overrides: Partial<AccountFacts> = {}): AccountFacts {
  return {
    accountId: "acme-shop.near",
    available: true,
    exists: true,
    implicit: false,
    createdAt: "2023-01-01T00:00:00.000Z",
    txCount: 500,
    ...overrides,
  };
}

function hoursOld(hours: number) {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

function codes(input: AccountFacts | null, request = NAMED) {
  return newAccountSignals(request, input, NOW).map((signal) => signal.code);
}

describe("newAccountSignals", () => {
  it("stays silent on an old, active account", () => {
    expect(codes(facts())).toEqual([]);
  });

  it("reports a named account that doesn't exist as critical", () => {
    const [signal] = newAccountSignals(NAMED, facts({ exists: false, createdAt: null, txCount: null }), NOW);
    expect(signal).toMatchObject({ code: "ACCOUNT_NOT_FOUND", severity: "critical", points: 70 });
  });

  it("treats an unfunded implicit account as valid, not as not found", () => {
    const [signal] = newAccountSignals(
      { payee: "a".repeat(64), chain: "near" },
      facts({ exists: false, implicit: true, createdAt: null, txCount: null }),
      NOW,
    );
    expect(signal).toMatchObject({ code: "IMPLICIT_ACCOUNT_UNFUNDED", severity: "medium", points: 20 });
  });

  it("checks a funded implicit account like any other", () => {
    expect(codes(facts({ implicit: true, createdAt: hoursOld(1), txCount: 1 }))).toEqual(["ACCOUNT_VERY_NEW", "ACCOUNT_LOW_ACTIVITY"]);
  });

  it("flags an account under 24 hours old", () => {
    const [signal] = newAccountSignals(NAMED, facts({ createdAt: hoursOld(2) }), NOW);
    expect(signal).toMatchObject({ code: "ACCOUNT_VERY_NEW", severity: "high", points: 30, evidence: { ageHours: 2 } });
    expect(signal?.message).toContain("2h");
  });

  it("flags an account under 7 days old as new, not very new", () => {
    const [signal] = newAccountSignals(NAMED, facts({ createdAt: hoursOld(48) }), NOW);
    expect(signal).toMatchObject({ code: "ACCOUNT_NEW", severity: "medium", points: 15 });
  });

  it.each([
    [23.9, ["ACCOUNT_VERY_NEW"]],
    [24, ["ACCOUNT_NEW"]],
    [24 * 7 - 0.1, ["ACCOUNT_NEW"]],
    [24 * 7, []],
  ])("at the boundary: %d hours old", (hours, expected) => {
    expect(codes(facts({ createdAt: hoursOld(hours) }))).toEqual(expected);
  });

  it("flags low activity on top of age", () => {
    expect(codes(facts({ createdAt: hoursOld(2), txCount: 0 }))).toEqual(["ACCOUNT_VERY_NEW", "ACCOUNT_LOW_ACTIVITY"]);
  });

  it.each([
    [0, true],
    [2, true],
    [3, false],
  ])("low activity with %i transactions: %s", (txCount, expected) => {
    expect(codes(facts({ txCount })).includes("ACCOUNT_LOW_ACTIVITY")).toBe(expected);
  });

  it("says 1 transaction, not 1 transactions", () => {
    expect(newAccountSignals(NAMED, facts({ txCount: 1 }), NOW)[0]?.message).toContain("1 transaction.");
  });

  it("never crashes when the source is unavailable", () => {
    const [signal] = newAccountSignals(NAMED, facts({ available: false, exists: false, createdAt: null, txCount: null }), NOW);
    expect(signal).toMatchObject({ code: "ACCOUNT_DATA_UNAVAILABLE", severity: "low", points: 5 });
  });

  it("never crashes when the lookup threw and there are no facts", () => {
    expect(codes(null)).toEqual(["ACCOUNT_DATA_UNAVAILABLE"]);
  });

  it("reports missing age once, when the account exists but the indexer has no date", () => {
    expect(codes(facts({ createdAt: null }))).toEqual(["ACCOUNT_DATA_UNAVAILABLE"]);
  });

  it("doesn't invent activity data when the count is missing", () => {
    expect(codes(facts({ txCount: null }))).toEqual([]);
  });

  it("stays silent on other chains rather than guessing", () => {
    expect(codes(null, { payee: "0xabc", chain: "base" })).toEqual([]);
  });
});
