import { describe, expect, it } from "vitest";
import { makeSignal, type SignalCode, SIGNALS, THRESHOLDS } from "../src/config.js";
import { decide } from "../src/decision.js";
import type { Signal } from "../src/types.js";

function signals(...codes: SignalCode[]): Signal[] {
  return codes.map((code) => makeSignal(code, `message for ${code}`));
}

/** A signal worth exactly `points`, with no severity or forcing of its own to affect the rules. */
function scored(points: number): Signal {
  return { detector: "new_account", code: "TEST_POINTS", severity: "low", points, message: `worth ${points}`, evidence: {} };
}

describe("score", () => {
  it("adds up the points", () => {
    expect(decide([scored(10), scored(15)]).riskScore).toBe(25);
  });

  it("never goes below 0", () => {
    expect(decide(signals("KNOWN_PAYEE")).riskScore).toBe(0);
  });

  it("never goes above 100", () => {
    expect(decide([scored(90), scored(90)]).riskScore).toBe(100);
  });
});

describe("rule 4: thresholds", () => {
  it.each<[number, string]>([
    [0, "ALLOW"],
    [29, "ALLOW"],
    [30, "HOLD"],
    [59, "HOLD"],
    [60, "BLOCK"],
    [100, "BLOCK"],
  ])("a score of %i is %s", (points, decision) => {
    expect(decide([scored(points)])).toMatchObject({ decision, rule: 4 });
  });

  it("no signals at all is ALLOW", () => {
    expect(decide([])).toMatchObject({ decision: "ALLOW", riskScore: 0 });
  });
});

describe("rule 1: a broken owner rule", () => {
  it.each<SignalCode>(["POLICY_OVER_PER_PAYMENT_LIMIT", "POLICY_OVER_DAILY_BUDGET", "POLICY_ASSET_NOT_ALLOWED", "POLICY_FROZEN"])(
    "%s forces BLOCK",
    (code) => {
      expect(decide(signals(code))).toMatchObject({ decision: "BLOCK", rule: 1 });
    },
  );

  it("beats a known-payee duplicate, which would otherwise HOLD", () => {
    expect(decide(signals("POLICY_FROZEN", "DUPLICATE_INVOICE", "KNOWN_PAYEE"))).toMatchObject({ decision: "BLOCK", rule: 1 });
  });
});

describe("rule 2: a duplicate to a payee you really pay", () => {
  it.each<SignalCode>(["DUPLICATE_INVOICE", "DUPLICATE_PAYMENT_WINDOW"])("%s on a known payee is HOLD", (code) => {
    expect(decide(signals(code, "KNOWN_PAYEE"))).toMatchObject({ decision: "HOLD", rule: 2 });
  });

  it("holds even though DUPLICATE_INVOICE is critical", () => {
    expect(SIGNALS.DUPLICATE_INVOICE.severity).toBe("critical");
    expect(decide(signals("DUPLICATE_INVOICE", "KNOWN_PAYEE")).decision).toBe("HOLD");
  });

  it("leads with the plain question the owner has to answer", () => {
    const duplicate = makeSignal("DUPLICATE_PAYMENT_WINDOW", "Identical payment settled 42s ago (tx abc…). Pay again?");
    const { reasons } = decide([duplicate, makeSignal("KNOWN_PAYEE", "known"), makeSignal("RETRY_PRESSURE", "retry")]);
    expect(reasons[0]).toBe("Identical payment settled 42s ago (tx abc…). Pay again?");
  });

  it("isn't disturbed by the retry pressure that usually comes with it", () => {
    expect(decide(signals("DUPLICATE_INVOICE", "KNOWN_PAYEE", "RETRY_PRESSURE"))).toMatchObject({ decision: "HOLD", rule: 2 });
  });

  it("an unknown payee doesn't get that benefit of the doubt", () => {
    expect(decide(signals("DUPLICATE_INVOICE"))).toMatchObject({ decision: "BLOCK", rule: 3 });
  });

  it.each<SignalCode>([
    "LOOKALIKE_HOMOGLYPH",
    "LOOKALIKE_EDIT_DISTANCE",
    "ACCOUNT_NOT_FOUND",
    "ACCOUNT_VERY_NEW",
    "CONTEXT_BYPASS_ATTEMPT",
    "CONTEXT_PAYEE_CHANGE",
    "CONTEXT_AMOUNT_MISMATCH",
    "CHAIN_ADDRESS_MISMATCH",
    "NETWORK_REPORTED_SCAM",
  ])("doesn't apply when %s also fires", (code) => {
    expect(decide(signals("DUPLICATE_INVOICE", "KNOWN_PAYEE", code)).rule).not.toBe(2);
  });

  it.each<SignalCode>(["ACCOUNT_LOW_ACTIVITY", "ACCOUNT_NEW", "CONTEXT_URGENCY", "AI_UNAVAILABLE"])(
    "still applies alongside the milder %s",
    (code) => {
      expect(decide(signals("DUPLICATE_PAYMENT_WINDOW", "KNOWN_PAYEE", code))).toMatchObject({ decision: "HOLD", rule: 2 });
    },
  );
});

describe("rule 3: anything critical", () => {
  const critical = (Object.keys(SIGNALS) as SignalCode[]).filter(
    (code) => SIGNALS[code].severity === "critical" && SIGNALS[code].detector !== "policy",
  );

  it.each(critical)("%s is BLOCK, even at a low score", (code) => {
    expect(decide(signals(code))).toMatchObject({ decision: "BLOCK", rule: 3 });
  });

  it("a known payee's -10 can't talk it down", () => {
    expect(decide(signals("CONTEXT_BYPASS_ATTEMPT", "KNOWN_PAYEE")).decision).toBe("BLOCK");
  });
});

describe("rule 5: rules that ask for the owner", () => {
  it.each<SignalCode>(["POLICY_NEW_PAYEE_REQUIRES_APPROVAL", "POLICY_ABOVE_APPROVAL_THRESHOLD", "RETRY_PRESSURE"])(
    "%s lifts ALLOW to HOLD",
    (code) => {
      expect(decide(signals(code))).toMatchObject({ decision: "HOLD", rule: 5 });
    },
  );

  it("never lowers a BLOCK", () => {
    expect(decide([...signals("POLICY_NEW_PAYEE_REQUIRES_APPROVAL"), scored(60)]).decision).toBe("BLOCK");
  });

  it("the retry case limits miss: known payee, new invoice, past the window, is held", () => {
    expect(decide(signals("RETRY_PRESSURE", "KNOWN_PAYEE"))).toMatchObject({ decision: "HOLD", rule: 5 });
  });
});

describe("reasons", () => {
  it("gives the top three by points", () => {
    const { reasons } = decide([scored(1), scored(4), scored(2), scored(3)]);
    expect(reasons).toEqual(["worth 4", "worth 3", "worth 2"]);
  });

  it("leaves out signals that added nothing", () => {
    const { reasons } = decide([scored(35), makeSignal("AI_UNAVAILABLE", "ai down")]);
    expect(reasons).toEqual(["worth 35"]);
  });

  it("reassures on a clean payment to a known payee", () => {
    expect(decide([makeSignal("KNOWN_PAYEE", "You've paid this payee 3 times before.")]).reasons).toEqual(["You've paid this payee 3 times before."]);
  });

  it("always says something", () => {
    expect(decide([]).reasons).toEqual(["No risk signals found."]);
  });

  it("ranks by points even on a forced BLOCK, so a lost-funds warning leads over a limit", () => {
    const { decision, reasons } = decide([
      makeSignal("POLICY_OVER_PER_PAYMENT_LIMIT", "over the limit"),
      makeSignal("CHAIN_ADDRESS_MISMATCH", "this address can't exist there"),
    ]);
    expect(decision).toBe("BLOCK");
    expect(reasons).toEqual(["this address can't exist there", "over the limit"]);
  });
});

// The table is the spec. A change here should be deliberate, and show up in a diff.
describe("score table", () => {
  it.each<[SignalCode, string, number]>([
    ["LOOKALIKE_HOMOGLYPH", "critical", 60],
    ["LOOKALIKE_EDIT_DISTANCE", "high", 40],
    ["LOOKALIKE_SUFFIX_TRICK", "high", 40],
    ["KNOWN_PAYEE", "info", -10],
    ["ACCOUNT_NOT_FOUND", "critical", 70],
    ["IMPLICIT_ACCOUNT_UNFUNDED", "medium", 20],
    ["ACCOUNT_VERY_NEW", "high", 30],
    ["ACCOUNT_NEW", "medium", 15],
    ["ACCOUNT_LOW_ACTIVITY", "low", 10],
    ["ACCOUNT_DATA_UNAVAILABLE", "low", 5],
    ["DUPLICATE_INVOICE", "critical", 70],
    ["DUPLICATE_PAYMENT_WINDOW", "high", 45],
    ["RETRY_PRESSURE", "medium", 20],
    ["VELOCITY_NEW_PAYEE", "high", 40],
    ["CONTEXT_PAYEE_CHANGE", "high", 35],
    ["CONTEXT_BYPASS_ATTEMPT", "critical", 50],
    ["CONTEXT_URGENCY", "low", 10],
    ["CONTEXT_PAYEE_MISMATCH", "high", 40],
    ["CONTEXT_AMOUNT_MISMATCH", "high", 35],
    ["AI_UNAVAILABLE", "info", 0],
    ["CHAIN_ADDRESS_MISMATCH", "critical", 60],
    ["NETWORK_REPORTED_SCAM", "critical", 80],
    ["NETWORK_REPORTED_LOOKALIKE_OF_YOUR_PAYEE", "critical", 10],
  ])("%s is %s, %i points", (code, severity, points) => {
    expect(SIGNALS[code]).toMatchObject({ severity, points });
  });

  it("only KNOWN_PAYEE can lower a score", () => {
    const negative = (Object.keys(SIGNALS) as SignalCode[]).filter((code) => SIGNALS[code].points < 0);
    expect(negative).toEqual(["KNOWN_PAYEE"]);
  });

  it("thresholds match the brief", () => {
    expect(THRESHOLDS).toMatchObject({ blockScore: 60, holdScore: 30, duplicateWindowMinutes: 15, velocityWindowMinutes: 10, velocityMinRequests: 3 });
  });
});

describe("a claim of approval that only the AI saw", () => {
  const known = makeSignal("KNOWN_PAYEE", "Known.");
  const claim = (sources: string[]) => makeSignal("CONTEXT_BYPASS_ATTEMPT", "Claims approval.", { sources });

  it("on a payee you really pay, it asks you and leads with the reason", () => {
    expect(decide([known, claim(["ai"])])).toMatchObject({ decision: "HOLD", rule: 2, riskScore: 40, reasons: ["Claims approval."] });
  });

  it("the built-in patterns still block, with or without the AI agreeing", () => {
    expect(decide([known, claim(["regex"])]).decision).toBe("BLOCK");
    expect(decide([known, claim(["regex", "ai"])]).decision).toBe("BLOCK");
    expect(decide([known, claim([])]).decision).toBe("BLOCK");
  });

  it("on a payee you've never paid, it still blocks", () => {
    expect(decide([claim(["ai"])]).decision).toBe("BLOCK");
    expect(decide([claim(["ai"]), makeSignal("POLICY_NEW_PAYEE_REQUIRES_APPROVAL", "New.")]).decision).toBe("BLOCK");
  });

  it.each(["CONTEXT_PAYEE_CHANGE", "CONTEXT_AMOUNT_MISMATCH", "DUPLICATE_INVOICE", "NETWORK_REPORTED_SCAM", "ACCOUNT_VERY_NEW"] as const)("with %s as well, it still blocks", (code) => {
    expect(decide([known, claim(["ai"]), makeSignal(code, "Also.")]).decision).toBe("BLOCK");
  });

  it("your own limits still come first", () => {
    expect(decide([known, claim(["ai"]), makeSignal("POLICY_OVER_PER_PAYMENT_LIMIT", "Over.")]).decision).toBe("BLOCK");
  });

  it("a lesser signal doesn't turn it back into a block", () => {
    expect(decide([known, claim(["ai"]), makeSignal("CONTEXT_URGENCY", "Hurry.")]).decision).toBe("HOLD");
  });
});
