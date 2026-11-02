import { describe, expect, it } from "vitest";
import seed from "../data/known-payees.json" with { type: "json" };
import { editDistance, lookalikeSignals, normalizeName } from "../src/detectors/lookalike.js";
import type { KnownPayee } from "../src/ledger.js";

function paid(accountId: string, paidCount = 3, chain = "near"): KnownPayee {
  return { accountId, chain, paidCount };
}

function codes(payee: string, known: KnownPayee[] = [paid("acme-shop.near")], seedPayees: readonly string[] = [], chain = "near") {
  return lookalikeSignals({ payee, chain }, known, seedPayees).map((signal) => signal.code);
}

describe("normalizeName", () => {
  it.each([
    ["sh0p", "shop"],
    ["SHOP", "shop"],
    ["shoop", "shop"],
    ["sho-p", "shop"],
    ["sh_op", "shop"],
    ["paypa1", "paypal"],
    ["paypai", "paypal"],
    ["c1oud", "cloud"],
    ["rnarket", "market"],
    ["vvallet", "wallet"],
    ["n3ar", "near"],
    ["4cme", "acme"],
    ["5hop", "shop"],
    ["s7ore", "store"],
    ["8ank", "bank"],
  ])("%s becomes %s", (input, expected) => {
    expect(normalizeName(input)).toBe(normalizeName(expected));
  });

  it("doesn't touch the payee itself: the result is only for comparing", () => {
    expect(normalizeName("sh0p")).not.toBe("sh0p");
    const [signal] = lookalikeSignals({ payee: "acme-sh0p.near", chain: "near" }, [paid("acme-shop.near")], []);
    expect(signal?.message).not.toContain("acme-sh0p");
    expect(signal?.evidence.lookalikeOf).toBe("acme-shop.near");
  });
});

describe("editDistance", () => {
  it.each([
    ["shop", "shop", 0],
    ["shop", "shot", 1],
    ["shop", "shops", 1],
    ["shop", "hop", 1],
    ["shop", "shpo", 1], // A swapped pair counts as one edit.
    ["shop", "shopify", 3],
    ["", "abc", 3],
    ["abc", "", 3],
  ])("%s to %s is %i", (a, b, expected) => {
    expect(editDistance(a, b)).toBe(expected);
  });
});

describe("KNOWN_PAYEE", () => {
  it("fires on an exact match with a paid payee, and nothing else does", () => {
    const signals = lookalikeSignals({ payee: "acme-shop.near", chain: "near" }, [paid("acme-shop.near", 3)], []);
    expect(signals.map((signal) => signal.code)).toEqual(["KNOWN_PAYEE"]);
    expect(signals[0]?.points).toBe(-10);
    expect(signals[0]?.message).toContain("3 times");
  });

  it("says once, not 1 times", () => {
    expect(lookalikeSignals({ payee: "a-shop.near", chain: "near" }, [paid("a-shop.near", 1)], [])[0]?.message).toContain("once");
  });

  it("doesn't fire for a payee never paid", () => {
    expect(codes("acme-shop.near", [paid("acme-shop.near", 0)])).toEqual([]);
  });

  it("works for a foreign address, ignoring EVM case", () => {
    const lower = "0xabcdef0000000000000000000000000000000001";
    const upper = "0xABCDEF0000000000000000000000000000000001";
    expect(codes(upper, [paid(lower, 2, "base")], [], "base")).toEqual(["KNOWN_PAYEE"]);
  });

  it("the same address on another chain isn't known", () => {
    const address = "0xabcdef0000000000000000000000000000000001";
    expect(codes(address, [paid(address, 2, "base")], [], "ethereum")).toEqual([]);
  });
});

describe("LOOKALIKE_HOMOGLYPH", () => {
  it.each([
    ["acme-sh0p.near"],
    ["acrne-shop.near"], // rn looks like m
    ["acme-shoop.near"],
    ["acmeshop.near"],
    ["acme_shop.near"],
    ["4cme-shop.near"],
    ["acm3-sh0p.near"],
    ["acme.shop.near"],
  ])("%s", (payee) => {
    expect(codes(payee)).toEqual(["LOOKALIKE_HOMOGLYPH"]);
  });

  it("is critical and worth 60 points", () => {
    const [signal] = lookalikeSignals({ payee: "acme-sh0p.near", chain: "near" }, [paid("acme-shop.near")], []);
    expect(signal).toMatchObject({ severity: "critical", points: 60 });
  });

  it("gives evidence the UI can highlight", () => {
    const [signal] = lookalikeSignals({ payee: "acme-sh0p.near", chain: "near" }, [paid("acme-shop.near", 3)], []);
    expect(signal?.evidence).toMatchObject({
      lookalikeOf: "acme-shop.near",
      knownSource: "paid",
      paidCount: 3,
      differingPositions: [7],
    });
  });

  it("works on names too short for the edit-distance rule", () => {
    expect(codes("r3f.near", [paid("ref.near")])).toEqual(["LOOKALIKE_HOMOGLYPH"]);
  });
});

describe("LOOKALIKE_SUFFIX_TRICK", () => {
  it.each([
    ["acme-shop-near.near"],
    ["acmeshopnear.near"],
    ["acme-shop.nearr"],
    ["acme-shop.tg"],
    ["pay-acme-shop.near"],
    ["acme-shop-pay.near"],
    ["official-acme-shop.near"],
    ["acme-shop.near.evil.near"],
    ["acme-sh0p-pay.near"],
    ["near-acme-shop.near"],
  ])("%s", (payee) => {
    expect(codes(payee)).toEqual(["LOOKALIKE_SUFFIX_TRICK"]);
  });

  it("is high and worth 40 points", () => {
    const [signal] = lookalikeSignals({ payee: "pay-acme-shop.near", chain: "near" }, [paid("acme-shop.near")], []);
    expect(signal).toMatchObject({ severity: "high", points: 40 });
  });
});

describe("LOOKALIKE_EDIT_DISTANCE", () => {
  it.each([
    ["acme-shp.near"],
    ["acme-shops.near"],
    ["acme-shpo.near"],
    ["acme-chop.near"],
    ["acne-shop.near"],
    ["acme-sho.near"],
    ["acne-shp.near"], // Two edits are allowed on a longer name.
  ])("%s", (payee) => {
    expect(codes(payee)).toEqual(["LOOKALIKE_EDIT_DISTANCE"]);
  });

  it("is high, worth 40 points, and reports the distance", () => {
    const [signal] = lookalikeSignals({ payee: "acme-shp.near", chain: "near" }, [paid("acme-shop.near")], []);
    expect(signal).toMatchObject({ severity: "high", points: 40, evidence: { distance: 1 } });
  });

  it("allows one edit on a short name", () => {
    expect(codes("shot.near", [paid("shop.near")])).toEqual(["LOOKALIKE_EDIT_DISTANCE"]);
  });
});

// False blocks are failures too. Every one of these must stay silent.
describe("near-misses that must NOT trigger", () => {
  it.each<[string, string]>([
    ["shopify.near", "shop.near"],
    ["bishop.near", "shop.near"],
    ["workshop.near", "shop.near"],
    ["soap.near", "shop.near"],
    ["acme-store.near", "acme-shop.near"],
    ["acme-labs.near", "acme-shop.near"],
    ["apex-shop.near", "acme-shop.near"],
    ["totally-different.near", "acme-shop.near"],
    ["ref.near", "rex.near"], // Too short for the edit-distance rule.
    ["usdc.near", "acme-shop.near"],
    ["payments.near", "acme-shop.near"],
  ])("%s against %s", (payee, known) => {
    expect(codes(payee, [paid(known)])).toEqual([]);
  });

  it("a child account of a known payee is really theirs: only the parent can create it", () => {
    expect(codes("payments.acme-shop.near")).toEqual([]);
  });

  it("an exact seed-list service isn't its own lookalike", () => {
    expect(codes("wrap.near", [], ["wrap.near"])).toEqual([]);
  });

  it("two similar names that are both seed services stay silent", () => {
    expect(codes("token.v2.ref-finance.near", [], seed)).toEqual([]);
    expect(codes("v2.ref-finance.near", [], seed)).toEqual([]);
  });

  it("every real service in the seed list passes against the rest of the list", () => {
    for (const service of seed) expect(codes(service, [], seed)).toEqual([]);
  });

  it("a payee the owner already paid isn't flagged, even if it resembles another", () => {
    expect(codes("acme-sh0p.near", [paid("acme-shop.near"), paid("acme-sh0p.near", 1)])).toEqual(["KNOWN_PAYEE"]);
  });

  it("implicit accounts have no name to imitate", () => {
    expect(codes("a".repeat(64))).toEqual([]);
  });

  it("addresses on other chains have no name to imitate", () => {
    expect(codes("0xabcdef0000000000000000000000000000000001", [paid("acme-shop.near")], [], "base")).toEqual([]);
  });

  it("no known payees and no seed list means nothing to compare with", () => {
    expect(codes("anything.near", [], [])).toEqual([]);
  });
});

describe("which known payee a match points to", () => {
  it("checks the seed list too", () => {
    const [signal] = lookalikeSignals({ payee: "wr4p.near", chain: "near" }, [], seed);
    expect(signal).toMatchObject({ code: "LOOKALIKE_HOMOGLYPH", evidence: { lookalikeOf: "wrap.near", knownSource: "seed" } });
    expect(signal?.message).toContain("known service");
  });

  it("prefers a payee the owner paid over a seed service", () => {
    const [signal] = lookalikeSignals({ payee: "wr4p.near", chain: "near" }, [paid("wrap.near", 2)], seed);
    expect(signal?.evidence).toMatchObject({ knownSource: "paid", paidCount: 2 });
  });

  it("a homoglyph outranks a weaker match to a different payee", () => {
    const known = [paid("acme-shops.near", 9), paid("acme-shop.near", 1)];
    const [signal] = lookalikeSignals({ payee: "acme-sh0p.near", chain: "near" }, known, []);
    expect(signal).toMatchObject({ code: "LOOKALIKE_HOMOGLYPH", evidence: { lookalikeOf: "acme-shop.near" } });
  });

  it("gives one signal, not a pile-up, when several rules match", () => {
    expect(lookalikeSignals({ payee: "acme-sh0p.near", chain: "near" }, [paid("acme-shop.near")], seed)).toHaveLength(1);
  });
});
