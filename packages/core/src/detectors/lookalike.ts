// D1. The first-ever payment to a scammer has no blocklist entry to catch it: only its resemblance to someone
// the owner already pays gives it away. The normalised form is used to compare against known payees, and is
// never used to rewrite the payee.
import { isImplicitAccount } from "../accounts.js";
import { makeSignal, THRESHOLDS } from "../config.js";
import { type KnownPayee, samePayee } from "../ledger.js";
import type { Chain, Signal } from "../types.js";

const CONFUSABLE: Record<string, string> = { "0": "o", "1": "l", i: "l", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b" };

export function normalizeName(name: string): string {
  const swapped = name.toLowerCase().replace(/rn/g, "m").replace(/vv/g, "w");
  const mapped = [...swapped].map((character) => CONFUSABLE[character] ?? character).join("");
  return mapped.replace(/[-_.]/g, "").replace(/(.)\1+/g, "$1");
}

/** Damerau-Levenshtein (optimal string alignment): a swapped pair of letters counts as one edit. */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const columns = b.length + 1;
  const table: number[] = new Array(rows * columns).fill(0);
  const at = (row: number, column: number) => table[row * columns + column] ?? 0;
  for (let row = 0; row < rows; row += 1) table[row * columns] = row;
  for (let column = 0; column < columns; column += 1) table[column] = column;
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      let best = Math.min(at(row - 1, column) + 1, at(row, column - 1) + 1, at(row - 1, column - 1) + cost);
      if (row > 1 && column > 1 && a[row - 1] === b[column - 2] && a[row - 2] === b[column - 1]) {
        best = Math.min(best, at(row - 2, column - 2) + 1);
      }
      table[row * columns + column] = best;
    }
  }
  return at(rows - 1, columns - 1);
}

interface Parts {
  name: string;
  tld: string;
}

function splitAccount(accountId: string): Parts {
  const dot = accountId.lastIndexOf(".");
  return dot === -1 ? { name: accountId, tld: "" } : { name: accountId.slice(0, dot), tld: accountId.slice(dot + 1) };
}

function tokens(name: string): string[] {
  return name.split(/[-_.]/).filter(Boolean).map(normalizeName);
}

/** True when `outer` holds every token of `inner` in a row, plus at least one more. */
function wrapsTokens(outer: string[], inner: string[]): boolean {
  if (inner.length === 0 || outer.length <= inner.length) return false;
  for (let start = 0; start + inner.length <= outer.length; start += 1) {
    if (inner.every((token, offset) => outer[start + offset] === token)) return true;
  }
  return false;
}

function isSuffixTrick(payee: Parts, known: Parts): boolean {
  const payeeName = normalizeName(payee.name);
  const knownName = normalizeName(known.name);
  if (payeeName === knownName && payee.tld !== known.tld) return true; // shop.nearr, shop.tg
  if (known.tld) {
    const tld = normalizeName(known.tld);
    if (payeeName === knownName + tld || payeeName === tld + knownName) return true; // shopnear.near
  }
  // shop-near.near, pay-shop.near. Only for names long enough that sharing a word means something.
  return known.name.length >= THRESHOLDS.editDistanceMinLength && wrapsTokens(tokens(payee.name), tokens(known.name));
}

function allowedEditDistance(knownName: string): number {
  if (knownName.length < THRESHOLDS.editDistanceMinLength) return 0;
  return knownName.length >= THRESHOLDS.editDistanceLongNameLength ? THRESHOLDS.editDistanceLong : THRESHOLDS.editDistanceShort;
}

type Match = "homoglyph" | "suffix" | "edit";

function matchAgainst(payeeId: string, knownId: string): Match | null {
  if (payeeId === knownId) return null;
  // Only the parent account can create a child, so pay.shop.near really does belong to shop.near.
  if (payeeId.endsWith(`.${knownId}`)) return null;
  const payee = splitAccount(payeeId);
  const known = splitAccount(knownId);
  if (normalizeName(payee.name) === normalizeName(known.name) && payee.tld === known.tld) return "homoglyph";
  if (isSuffixTrick(payee, known)) return "suffix";
  const allowed = allowedEditDistance(known.name);
  if (allowed > 0 && editDistance(payee.name, known.name) <= allowed) return "edit";
  return null;
}

/** Where two same-length ids differ, so the UI can highlight the swapped character. */
function differingPositions(a: string, b: string): number[] | null {
  if (a.length !== b.length) return null;
  const positions: number[] = [];
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) positions.push(index);
  return positions;
}

function knownLabel(accountId: string, paidCount: number): string {
  if (paidCount === 0) return `the known service ${accountId}`;
  return `${accountId}, a payee you paid ${paidCount === 1 ? "once" : `${paidCount} times`}`;
}

const PRIORITY: Match[] = ["homoglyph", "suffix", "edit"];

export function lookalikeSignals(
  request: { payee: string; chain: Chain },
  known: KnownPayee[],
  seedPayees: readonly string[],
): Signal[] {
  const exact = known.find((candidate) => samePayee({ payee: candidate.accountId, chain: candidate.chain }, request));
  if (exact && exact.paidCount >= 1) {
    return [
      makeSignal("KNOWN_PAYEE", `You've paid this payee ${exact.paidCount === 1 ? "once" : `${exact.paidCount} times`} before.`, {
        paidCount: exact.paidCount,
      }),
    ];
  }
  // Name tricks exist only for named NEAR accounts; addresses and implicit ids have no name to imitate.
  if (request.chain !== "near" || isImplicitAccount(request.payee)) return [];
  if (seedPayees.includes(request.payee)) return [];

  // Payees the owner actually paid outrank the seed list, and the most-paid come first.
  const paid = known
    .filter((candidate) => candidate.chain === "near" && !isImplicitAccount(candidate.accountId))
    .sort((a, b) => b.paidCount - a.paidCount);
  const candidates = [
    ...paid.map(({ accountId, paidCount }) => ({ accountId, paidCount })),
    ...seedPayees.map((accountId) => ({ accountId, paidCount: 0 })),
  ];

  let best: { match: Match; accountId: string; paidCount: number } | null = null;
  for (const candidate of candidates) {
    const match = matchAgainst(request.payee, candidate.accountId);
    if (match && (!best || PRIORITY.indexOf(match) < PRIORITY.indexOf(best.match))) best = { match, ...candidate };
  }
  if (!best) return [];

  const evidence = {
    lookalikeOf: best.accountId,
    knownSource: best.paidCount > 0 ? "paid" : "seed",
    paidCount: best.paidCount,
    differingPositions: differingPositions(request.payee, best.accountId),
  };
  const target = knownLabel(best.accountId, best.paidCount);
  if (best.match === "homoglyph") {
    return [makeSignal("LOOKALIKE_HOMOGLYPH", `This name is made to look like ${target}.`, evidence)];
  }
  if (best.match === "suffix") {
    return [makeSignal("LOOKALIKE_SUFFIX_TRICK", `This name wraps or changes the ending of ${target}.`, evidence)];
  }
  return [
    makeSignal("LOOKALIKE_EDIT_DISTANCE", `This name is nearly identical to ${target}.`, {
      ...evidence,
      distance: editDistance(splitAccount(request.payee).name, splitAccount(best.accountId).name),
    }),
  ];
}
