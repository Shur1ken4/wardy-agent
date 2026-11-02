import { describe, expect, it } from "vitest";
import { createEventParser, type ServerEvent } from "../src/lib/events";
import { approvalQuestion, assetLabel, codeWords, formatAmount, payeeParts, txUrl } from "../src/lib/format";
import { upsertVerdict } from "../src/lib/dashboard";
import type { VerdictView } from "@wardy-agent/core";

const marked = (parts: { text: string; differs: boolean }[]) => parts.filter((part) => part.differs).map((part) => part.text);
const whole = (parts: { text: string }[]) => parts.map((part) => part.text).join("");

describe("payeeParts: marking what gives a lookalike away", () => {
  it("marks the positions the detector found", () => {
    const parts = payeeParts("acme-sh0p.near", "acme-shop.near", [7]);
    expect(marked(parts)).toEqual(["0"]);
    expect(whole(parts)).toBe("acme-sh0p.near");
  });

  it("marks several", () => {
    expect(marked(payeeParts("g1obex-supp1y.near", "globex-supply.near", [1, 11]))).toEqual(["1", "1"]);
  });

  it("works it out when the detector gives no positions: the trick ending", () => {
    const parts = payeeParts("acme-shop-near.near", "acme-shop.near");
    expect(marked(parts)).toEqual(["-near"]);
    expect(whole(parts)).toBe("acme-shop-near.near");
  });

  it("works it out for one changed character", () => {
    expect(marked(payeeParts("g1obex-supply.near", "globex-supply.near"))).toEqual(["1"]);
  });

  it("marks nothing with nothing to compare to", () => {
    expect(payeeParts("acme-shop.near")).toEqual([{ text: "acme-shop.near", differs: false }]);
  });

  it("marks nothing when the names match", () => {
    expect(marked(payeeParts("acme-shop.near", "acme-shop.near"))).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["text", "7"],
    ["out of range", [99]],
    ["negative", [-1]],
    ["fractions", [1.5]],
    ["not numbers", ["x", null]],
  ])("ignores positions that are %s", (_name, positions) => {
    const parts = payeeParts("abc.near", undefined, positions);
    expect(marked(parts)).toEqual([]);
    expect(whole(parts)).toBe("abc.near");
  });

  it("never loses a character, however odd the input", () => {
    for (const [payee, real] of [["a", "abc"], ["abc", "a"], ["", "x"], ["xyz", "abc"]] as const) {
      expect(whole(payeeParts(payee, real))).toBe(payee);
    }
  });
});

describe("amounts and assets", () => {
  it("names the two assets the demo uses, and doesn't invent others", () => {
    expect(assetLabel("nep141:wrap.near")).toBe("NEAR");
    expect(assetLabel("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1")).toBe("USDC");
    expect(assetLabel("other")).toBe("other");
    expect(assetLabel("nep141:a-very-long-token-contract-name.near")).toContain("…");
  });

  it("shows the amount exactly as it was signed", () => {
    expect(formatAmount("10.36", "nep141:wrap.near")).toBe("10.36 NEAR");
    expect(formatAmount("0.010", "x")).toBe("0.010 x");
  });
});

describe("txUrl: a link only where there's something to see", () => {
  it("has no link for a mock payment: there's no transaction", () => {
    expect(txUrl("offline", "mock", "mock-123")).toBeNull();
    expect(txUrl("testnet", "mock", "mock-123")).toBeNull();
  });

  it("has no link without a hash", () => {
    expect(txUrl("testnet", "outlayer", undefined)).toBeNull();
  });

  it("points at the right network", () => {
    expect(txUrl("testnet", "outlayer", "ABC")).toBe("https://testnet.near.rocks/tx/ABC");
    expect(txUrl("live", "agent-connect", "ABC")).toBe("https://near.rocks/tx/ABC");
  });

  it("has no link in offline mode, whatever the provider says", () => {
    expect(txUrl("offline", "outlayer", "ABC")).toBeNull();
  });
});

describe("approvalQuestion: the words the owner decides on", () => {
  const base = { payee: "acme-shop.near", amount: "2", asset: "nep141:wrap.near" };
  const signal = (code: string, evidence: Record<string, unknown> = {}) => ({ detector: "duplicate" as const, code, severity: "high" as const, points: 40, message: "x", evidence });

  it.each(["DUPLICATE_INVOICE", "DUPLICATE_PAYMENT_WINDOW", "RETRY_PRESSURE"])("%s is a repeat, and says so", (code) => {
    const question = approvalQuestion({ ...base, signals: [signal(code, { txHash: "TX1" })] });
    expect(question.isRepeat).toBe(true);
    expect(question.headline).toContain("again?");
    expect(question.firstTx).toBe("TX1");
  });

  it("doesn't say 'again' about a first-time payee", () => {
    const question = approvalQuestion({ ...base, signals: [signal("ACCOUNT_VERY_NEW")] });
    expect(question.isRepeat).toBe(false);
    expect(question.headline).not.toContain("again");
    expect(question.firstTx).toBeUndefined();
  });

  it("keeps the amount and asset together", () => {
    expect(approvalQuestion({ ...base, signals: [] }).headline).toContain("2 NEAR");
  });
});

describe("codeWords", () => {
  it("says it plainly", () => {
    expect(codeWords("LOOKALIKE_HOMOGLYPH")).toBe("Lookalike name");
  });
  it("has a readable fallback, not a raw code", () => {
    expect(codeWords("SOME_NEW_CODE")).toBe("Some new code");
  });
});

describe("the event parser", () => {
  function collect() {
    const events: ServerEvent[] = [];
    return { events, parse: createEventParser((event) => events.push(event)) };
  }

  it("reads a whole event", () => {
    const { events, parse } = collect();
    parse('event: verdict\ndata: {"a":1}\n\n');
    expect(events).toEqual([{ event: "verdict", data: { a: 1 } }]);
  });

  it("handles an event split across chunks, even mid-word", () => {
    const { events, parse } = collect();
    for (const piece of ["eve", "nt: verd", 'ict\ndata: {"a"', ":1}\n", "\n"]) parse(piece);
    expect(events).toEqual([{ event: "verdict", data: { a: 1 } }]);
  });

  it("handles several in one chunk", () => {
    const { events, parse } = collect();
    parse('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n');
    expect(events.map(({ event }) => event)).toEqual(["a", "b"]);
  });

  it("skips comments and keep-alives", () => {
    const { events, parse } = collect();
    parse(": connected\n\n: ping\n\n");
    expect(events).toEqual([]);
  });

  it("a bad event doesn't stop the feed", () => {
    const { events, parse } = collect();
    parse('event: a\ndata: {not json\n\nevent: b\ndata: 2\n\n');
    expect(events).toEqual([{ event: "b", data: 2 }]);
  });

  it("waits for the end of an event", () => {
    const { events, parse } = collect();
    parse('event: a\ndata: 1\n');
    expect(events).toEqual([]);
  });
});

describe("upsertVerdict: one row per verdict", () => {
  const verdict = (verdictId: string, extra: Partial<VerdictView> = {}) => ({ verdictId, payee: "x.near", ...extra }) as VerdictView;

  it("puts a new one first", () => {
    expect(upsertVerdict([verdict("a")], verdict("b")).map(({ verdictId }) => verdictId)).toEqual(["b", "a"]);
  });

  it("updates in place, so a row doesn't jump when its payment settles", () => {
    const list = upsertVerdict([verdict("b"), verdict("a")], verdict("a", { networkReportId: "r" }));
    expect(list.map(({ verdictId }) => verdictId)).toEqual(["b", "a"]);
    expect(list[1]?.networkReportId).toBe("r");
  });

  it("doesn't grow forever", () => {
    let list: VerdictView[] = [];
    for (let index = 0; index < 150; index += 1) list = upsertVerdict(list, verdict(String(index)));
    expect(list).toHaveLength(100);
    expect(list[0]?.verdictId).toBe("149");
  });
});
