// What the screens really put on the page, rendered to text. These are the promises that matter: hostile text stays
// inert, a tick is only shown when it's earned, and every label says what's true.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { merkleProof, merkleRoot } from "@wardy-agent/core/merkle";
import { generateSigningKey, publicKeyOf, signVerdict } from "@wardy-agent/core/sign";
import type { PayeeLookup, Signal, VerdictView } from "@wardy-agent/core";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { policyChipText } from "../src/components/Header";
import { Payee, StatTile } from "../src/components/parts";
import { ReadPrivately, VerdictDetail } from "../src/components/VerdictDetail";
import { HoldCard, Outcome, takeToken } from "../src/screens/Approve";
import { Tiles } from "../src/screens/Live";
import { type LabScenario, ResultsTable, Totals } from "../src/screens/AttackLab";
import type { Stats } from "../src/lib/api";
import { startCountUp } from "../src/lib/countUp";
import { type Dashboard, DashboardContext } from "../src/lib/dashboard";
import { checkSignature } from "../src/lib/verify";
import { proofHolds } from "../src/screens/Network";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const HOSTILE = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

function signal(overrides: Partial<Signal> = {}): Signal {
  return { detector: "new_account", code: "ACCOUNT_VERY_NEW", severity: "high", points: 30, message: "This account was created only 2h ago.", evidence: {}, ...overrides };
}

function verdict(overrides: Partial<VerdictView> = {}): VerdictView {
  return {
    verdictId: "11111111-1111-4111-8111-111111111111",
    requestId: "22222222-2222-4222-8222-222222222222",
    mode: "pay",
    requestHash: "a".repeat(64),
    payee: "acme-shop.near",
    chain: "near",
    asset: "nep141:wrap.near",
    amount: "2",
    decision: "BLOCK",
    riskScore: 90,
    signals: [signal()],
    reasons: ["This account was created only 2h ago."],
    wardyPublicKey: "b".repeat(64),
    signature: "c".repeat(128),
    createdAt: "2026-11-05T12:00:00.000Z",
    ...overrides,
  };
}

const LOOKALIKE = signal({ detector: "lookalike", code: "LOOKALIKE_HOMOGLYPH", severity: "critical", evidence: { lookalikeOf: "acme-shop.near", knownSource: "paid", paidCount: 3, differingPositions: [7] } });

describe("untrusted text can't become markup", () => {
  const renders: [string, () => string][] = [
    ["a reason", () => renderToStaticMarkup(<VerdictDetail verdict={verdict({ reasons: [HOSTILE] })} mode="offline" />)],
    ["a signal message", () => renderToStaticMarkup(<VerdictDetail verdict={verdict({ signals: [signal({ message: HOSTILE })] })} mode="offline" />)],
    ["signal evidence", () => renderToStaticMarkup(<VerdictDetail verdict={verdict({ signals: [signal({ evidence: { note: HOSTILE } })] })} mode="offline" />)],
    ["a payee", () => renderToStaticMarkup(<Payee payee={HOSTILE} />)],
    ["a marked payee", () => renderToStaticMarkup(<Payee payee={HOSTILE} lookalikeOf="acme-shop.near" />)],
    ["an agent name", () => renderToStaticMarkup(<VerdictDetail verdict={verdict({ agentId: HOSTILE })} mode="offline" />)],
    ["an AI model name", () => renderToStaticMarkup(<ReadPrivately ai={{ used: true, attested: false, model: HOSTILE }} />)],
    ["an execution note", () => renderToStaticMarkup(<VerdictDetail verdict={verdict({ execution: { status: "refused", provider: "mock", note: HOSTILE } })} mode="offline" />)],
    ["the phone's reasons", () => renderToStaticMarkup(<HoldCard verdict={verdict({ decision: "HOLD", reasons: [HOSTILE, HOSTILE] })} expiresAt="2026-11-05T12:30:00.000Z" busy={false} onDecide={() => {}} />)],
    ["the phone's payee", () => renderToStaticMarkup(<HoldCard verdict={verdict({ decision: "HOLD", payee: HOSTILE })} expiresAt="2026-11-05T12:30:00.000Z" busy={false} onDecide={() => {}} />)],
    ["the outcome's note", () => renderToStaticMarkup(<Outcome verdict={verdict({ execution: { status: "failed", provider: "mock", note: HOSTILE } })} />)],
    ["an Attack Lab title", () => renderToStaticMarkup(<ResultsTable rows={[{ id: "A1", title: HOSTILE, setup: HOSTILE, kind: "attack", without: { lost: {} }, with: { steps: [], lost: {} } }]} />)],
  ];

  it.each(renders)("%s", (_name, render) => {
    const html = render();
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;");
  });
});

describe("the source itself", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
  const sources = files(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

  it.each(["dangerouslySetInnerHTML", "innerHTML", "eval(", "new Function", "document.write"])("never uses %s", (needle) => {
    for (const { path, text } of sources) expect(text.includes(needle), path).toBe(false);
  });

  it("only knows these outside addresses: so it can't quietly call anything else", () => {
    const allowed = new Set(["https://test.rpc.fastnear.com", "https://testnet.near.rocks", "https://near.rocks"]);
    const seen = sources.flatMap(({ text }) => [...text.matchAll(/https?:\/\/[^\s"'`)/]+/g)].map((match) => match[0]));
    for (const address of seen) {
      if (address === "http://x") continue; // A placeholder base for parsing a path, never fetched.
      expect(allowed.has(address), address).toBe(true);
    }
  });

  it("fonts ship with the app: a clean clone works offline, and the approval page calls nobody", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).not.toMatch(/https?:\/\//);
    for (const { path, text } of sources) expect(text.includes("googleapis"), path).toBe(false);
  });

  it("the approval page tells the browser not to send a referrer", () => {
    expect(readFileSync(new URL("../index.html", import.meta.url), "utf8")).toContain('name="referrer" content="no-referrer"');
  });

  it("never says just 'Wardy': that's a different, older app", () => {
    for (const { path, text } of sources) {
      const lone = [...text.matchAll(/\bWardy\b(?! Agent| Network)/g)];
      expect(lone.length, path).toBe(0);
    }
  });

  it("uses only transform and opacity for motion", () => {
    const css = sources.find(({ path }) => path.endsWith("styles.css"))?.text ?? "";
    for (const [, body] of css.matchAll(/@keyframes [\w-]+ \{(.*?)\}\s*\}?/gs)) {
      expect(body).toMatch(/transform|opacity/);
      expect(body).not.toMatch(/\b(width|height|top|left|margin|padding)\s*:/);
    }
  });

  it("turns motion off for anyone who asks", () => {
    expect(sources.find(({ path }) => path.endsWith("styles.css"))?.text).toContain("prefers-reduced-motion");
    expect(sources.find(({ path }) => path.endsWith("main.tsx"))?.text).toContain('reducedMotion="user"');
  });
});

describe("Read privately: a tick only when it's earned", () => {
  const TICK = "✓";

  it("a verified attestation gets the tick, and says what was proven", () => {
    const html = renderToStaticMarkup(<ReadPrivately ai={{ used: true, attested: true, model: "z-ai/glm-5.3-flash", attestationLevel: "full", signatureKind: "provider_tee", attestationRef: "ref-123" }} />);
    expect(html).toContain(TICK);
    expect(html).toContain("z-ai/glm-5.3-flash");
    expect(html).toContain("ref-123");
    expect(html).toContain("the model&#x27;s TEE");
  });

  it("a model that answered without attestation gets no tick: this is what a replay looks like", () => {
    const html = renderToStaticMarkup(<ReadPrivately ai={{ used: true, attested: false, model: "m" }} />);
    expect(html).not.toContain(TICK);
    expect(html).toContain("✗");
    expect(html).toContain("isn&#x27;t verified");
  });

  it.each<[string, Parameters<typeof ReadPrivately>[0]["ai"]]>([["no AI at all", undefined], ["AI not used", { used: false, attested: false }]])("%s gets no tick, and says the rules read it", (_name, ai) => {
    const html = renderToStaticMarkup(<ReadPrivately ai={ai} />);
    expect(html).not.toContain(TICK);
    expect(html).toContain("didn&#x27;t run");
  });
});

describe("the verdict detail", () => {
  it("puts the two names side by side, with the odd character marked", () => {
    const html = renderToStaticMarkup(<VerdictDetail verdict={verdict({ payee: "acme-sh0p.near", signals: [LOOKALIKE] })} mode="offline" />);
    expect(html).toContain("You paid before, 3 times");
    expect(html).toContain("Agent tried to pay");
    expect(html).toContain("acme-shop.near");
    expect(html).toContain('<mark class="diff diff-sweep">0</mark>');
  });

  it("doesn't claim you paid a name you never did", () => {
    const seeded = signal({ detector: "lookalike", code: "LOOKALIKE_HOMOGLYPH", evidence: { lookalikeOf: "wrap.near", knownSource: "seed" } });
    const html = renderToStaticMarkup(<VerdictDetail verdict={verdict({ payee: "wrap-near.near", signals: [seeded] })} mode="offline" />);
    expect(html).toContain("The real name");
    expect(html).not.toContain("You paid before");
  });

  it("shows no comparison without a lookalike", () => {
    expect(renderToStaticMarkup(<VerdictDetail verdict={verdict()} mode="offline" />)).not.toContain("Agent tried to pay");
  });

  it("a mock payment has no link, and says it's a mock", () => {
    const html = renderToStaticMarkup(<VerdictDetail verdict={verdict({ decision: "ALLOW", execution: { status: "executed", provider: "mock", txHash: "mock-abc" } })} mode="offline" />);
    expect(html).toContain("(mock ledger)");
    expect(html).not.toContain("near.rocks");
  });

  it("a real testnet payment links to the explorer, safely", () => {
    const html = renderToStaticMarkup(<VerdictDetail verdict={verdict({ decision: "ALLOW", execution: { status: "executed", provider: "outlayer", txHash: "REALHASH" } })} mode="testnet" />);
    expect(html).toContain('href="https://testnet.near.rocks/tx/REALHASH"');
    expect(html).toContain('rel="noreferrer"');
  });

  it("says plainly when the money may have moved", () => {
    expect(renderToStaticMarkup(<VerdictDetail verdict={verdict({ execution: { status: "uncertain", provider: "x" } })} mode="live" />)).toContain("may have moved");
  });

  it("explains that a check can't move anything", () => {
    expect(renderToStaticMarkup(<VerdictDetail verdict={verdict({ mode: "check" })} mode="offline" />)).toContain("nothing could move");
  });
});

describe("the phone", () => {
  const card = (overrides: Partial<VerdictView>) => renderToStaticMarkup(<HoldCard verdict={verdict({ decision: "HOLD", ...overrides })} expiresAt="2026-11-05T12:30:00.000Z" busy={false} onDecide={() => {}} />);
  const repeat = signal({ detector: "duplicate", code: "DUPLICATE_INVOICE", evidence: { txHash: "FIRSTTXHASH" } });

  it("a repeat asks about paying again, and shows the first payment", () => {
    const html = card({ signals: [repeat], reasons: ["Already paid."] });
    expect(html).toContain("again?");
    expect(html).toContain("Reject — don&#x27;t pay twice");
    expect(html).toContain("Approve anyway");
    expect(html).toContain("FIRSTTXHASH");
  });

  it("a first-time payee doesn't talk about paying twice", () => {
    const html = card({ reasons: ["You've never paid this payee."] });
    expect(html).not.toContain("again?");
    expect(html).not.toContain("twice");
    expect(html).toContain("Reject — don&#x27;t pay");
  });

  it("buttons stop working while a decision is on its way: no double tap", () => {
    const html = renderToStaticMarkup(<HoldCard verdict={verdict({ decision: "HOLD" })} expiresAt="2026-11-05T12:30:00.000Z" busy onDecide={() => {}} />);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });

  it("further reasons are tucked away, not lost", () => {
    const html = card({ reasons: ["First reason.", "Second reason.", "Third reason."] });
    expect(html).toContain("First reason.");
    expect(html).toContain("2 more reasons");
    expect(html).toContain("Third reason.");
  });

  it("the outcome says what really happened", () => {
    expect(renderToStaticMarkup(<Outcome verdict={verdict({ execution: { status: "executed", provider: "mock", txHash: "T" } })} />)).toContain("Approved and paid");
    expect(renderToStaticMarkup(<Outcome verdict={verdict({ execution: { status: "refused", provider: "mock", note: "You rejected this payment." } })} />)).toContain("Nothing was paid");
    const failed = renderToStaticMarkup(<Outcome verdict={verdict({ execution: { status: "failed", provider: "mock", note: "No funds." } })} />);
    expect(failed).toContain("Nothing was paid");
    expect(failed).not.toContain("Approved");
  });

  describe("the link's token", () => {
    afterEach(() => vi.unstubAllGlobals());

    function browser(hash: string) {
      const store = new Map<string, string>();
      const replaceState = vi.fn();
      vi.stubGlobal("window", { location: { hash, pathname: "/approve/abc" } });
      vi.stubGlobal("history", { replaceState });
      vi.stubGlobal("sessionStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) });
      return { replaceState };
    }

    it("comes out of the address bar at once, and a reload still works", () => {
      const { replaceState } = browser("#token=SECRET");
      expect(takeToken("abc")).toBe("SECRET");
      expect(replaceState).toHaveBeenCalledWith(null, "", "/approve/abc");
      vi.stubGlobal("window", { location: { hash: "", pathname: "/approve/abc" } });
      expect(takeToken("abc")).toBe("SECRET");
    });

    it("one payment's token isn't used for another", () => {
      browser("#token=SECRET");
      takeToken("abc");
      vi.stubGlobal("window", { location: { hash: "", pathname: "/approve/other" } });
      expect(takeToken("other")).toBeNull();
    });

    it("no token means no token", () => {
      browser("");
      expect(takeToken("abc")).toBeNull();
    });
  });
});

describe("checkSignature: the Verify button", () => {
  const KEY = generateSigningKey();
  const signed = () =>
    signVerdict(
      { verdictId: crypto.randomUUID(), requestId: crypto.randomUUID(), mode: "pay", requestHash: "a".repeat(64), payee: "x.near", chain: "near", asset: "a", amount: "2", decision: "BLOCK", riskScore: 90, signals: [], reasons: ["r"], createdAt: "2026-11-05T12:00:00.000Z" },
      KEY,
    );

  it("accepts a real signature, and says it was checked here", async () => {
    const verdict = await signed();
    const check = await checkSignature(verdict, { valid: true, publicKey: await publicKeyOf(KEY) }, true);
    expect(check.valid).toBe(true);
    expect(check.where).toContain("this browser");
  });

  it("catches a changed amount, even if the server says it's fine", async () => {
    const verdict = await signed();
    expect((await checkSignature({ ...verdict, amount: "2000" }, { valid: true, publicKey: await publicKeyOf(KEY) }, true)).valid).toBe(false);
  });

  it("catches a signature from another key, even if the server says it's fine", async () => {
    const verdict = await signed();
    expect((await checkSignature(verdict, { valid: true, publicKey: await publicKeyOf(generateSigningKey()) }, true)).valid).toBe(false);
  });

  it("without browser crypto, relies on the server, and says so", async () => {
    const verdict = await signed();
    const check = await checkSignature(verdict, { valid: false, publicKey: "k" }, false);
    expect(check.valid).toBe(false);
    expect(check.where).toContain("Checked by the server");
  });
});

describe("the phone's first payment", () => {
  const repeat = signal({ detector: "duplicate", code: "DUPLICATE_INVOICE", evidence: { txHash: "FIRSTTX" } });
  const card = (mode: string | undefined, provider: string) =>
    renderToStaticMarkup(<HoldCard verdict={verdict({ decision: "HOLD", signals: [repeat], execution: { status: "pending_owner", provider } })} expiresAt="2026-11-05T12:30:00.000Z" busy={false} mode={mode} onDecide={() => {}} />);

  it("links to the explorer when there's a real transaction", () => {
    expect(card("testnet", "outlayer-testnet")).toContain('href="https://testnet.near.rocks/tx/FIRSTTX"');
  });

  it("has no link on a mock ledger", () => {
    expect(card("offline", "mock")).not.toContain("near.rocks");
    expect(card("offline", "mock")).toContain("FIRSTTX");
  });
});

describe("the policy chip only claims a signature where there is one", () => {
  it("offline and testnet don't say signed", () => {
    expect(policyChipText("offline", "mock")).not.toContain("signed");
    expect(policyChipText("testnet", "outlayer")).not.toContain("signed");
  });
  it("live does", () => {
    expect(policyChipText("live", "agent-connect")).toBe("Policy signed · agent-connect");
  });
  it("says nothing until it knows", () => {
    expect(policyChipText(undefined, undefined)).toBe("");
  });
});

describe("the Attack Lab's table", () => {
  const row = (overrides: Partial<LabScenario> = {}): LabScenario => ({
    id: "A1",
    title: "Lookalike payee",
    setup: "Invoice says the account moved",
    kind: "attack",
    without: { lost: { "nep141:wrap.near": "2" } },
    with: { steps: [{ decision: "BLOCK", verdictId: "v-1", ownerDecision: null }], lost: {} },
    ...overrides,
  });

  it("shows both worlds, with a link to each verdict", () => {
    const html = renderToStaticMarkup(<ResultsTable rows={[row()]} />);
    expect(html).toContain("2 NEAR");
    expect(html).toContain("BLOCK");
    expect(html).toContain('href="/attack-lab?verdict=v-1"');
  });

  it("marks money that was still lost, instead of hiding it", () => {
    const html = renderToStaticMarkup(<ResultsTable rows={[row({ with: { steps: [{ decision: "ALLOW", verdictId: "v", ownerDecision: null }], lost: { "nep141:wrap.near": "3" } } })]} />);
    expect(html).toContain('class="num lost"');
    expect(html).toContain("3 NEAR");
  });

  it("says when the owner stepped in", () => {
    const html = renderToStaticMarkup(<ResultsTable rows={[row({ with: { steps: [{ decision: "HOLD", verdictId: "v", ownerDecision: "reject" }], lost: {} } })]} />);
    expect(html).toContain("The owner rejects");
  });

  it("totals are the run's own numbers", () => {
    const html = renderToStaticMarkup(<Totals totals={{ lostWithout: { "nep141:wrap.near": "27.36" }, lostWith: {}, honestPassed: 4, honestTotal: 4, falseBlocks: 1 }} />);
    expect(html).toContain("NEAR");
    expect(html).toContain("False blocks");
    expect(html).toContain(">1<");
  });
});

describe("proofHolds: checked in the browser, against the anchored root", () => {
  const leaves = ["aa".repeat(32), "bb".repeat(32), "cc".repeat(32)];
  const anchoredRoot = { network: "testnet", contractId: "c", root: merkleRoot(leaves), count: 3, uri: "", blockHeight: "1", anchoredAt: "", txHash: "t", txUrl: "" };
  const answer = (overrides: Partial<PayeeLookup>): PayeeLookup => ({ reported: true, reports: [], withdrawn: [], merkleProof: merkleProof(leaves, 1), anchoredRoot, anchorTx: "t", ...overrides });

  it("holds for a real proof", () => {
    expect(proofHolds(answer({}))).toBe(true);
  });

  it("fails when the proof is for another root", () => {
    expect(proofHolds(answer({ anchoredRoot: { ...anchoredRoot, root: "f".repeat(64) } }))).toBe(false);
  });

  it("fails on a false count", () => {
    expect(proofHolds(answer({ anchoredRoot: { ...anchoredRoot, count: 4 } }))).toBe(false);
  });

  it("fails with no proof or no anchor", () => {
    expect(proofHolds(answer({ merkleProof: null }))).toBe(false);
    expect(proofHolds(answer({ anchoredRoot: null }))).toBe(false);
  });
});

describe("the tiles never claim a number they don't know", () => {
  const withStats = (stats: Stats | null) =>
    renderToStaticMarkup(
      <DashboardContext.Provider value={{ stats } as Dashboard}>
        <Tiles />
      </DashboardContext.Provider>,
    );
  const values = (html: string) => [...html.matchAll(/class="tile-value">(.*?)<\/div>/g)].map((match) => match[1]);

  it("before the numbers arrive, every tile shows a dash, not a zero", () => {
    expect(values(withStats(null))).toEqual(["–", "–", "–", "–", "–"]);
  });

  it("once they arrive, it shows them", () => {
    const html = withStats({ checkedToday: 9, blockedToday: 4, heldNow: 1, paidToday: 3, saved: [{ asset: "nep141:wrap.near", amount: "10.36" }], checksForOthers: 1, earned: { checksSold: 0, revenue: [] } });
    expect(values(html).slice(0, 3)).toEqual(["9", "4", "1"]);
    expect(html).toContain("10.36");
    expect(html).toContain("NEAR");
  });

  it("a real zero is still a zero", () => {
    expect(values(withStats({ checkedToday: 0, blockedToday: 0, heldNow: 0, paidToday: 0, saved: [], checksForOthers: 0, earned: { checksSold: 0, revenue: [] } }))).toEqual(["0", "0", "0", "0", "0"]);
  });
});

describe("startCountUp: the exact number always wins", () => {
  afterEach(() => vi.useRealTimers());

  /** An animation like one in a background tab: its first frame runs, then it never finishes. */
  const stalled = (from: number) => (_start: number, _end: number, options: { onUpdate(latest: number): void }) => {
    options.onUpdate(from);
    return { stop: vi.fn() };
  };

  it("clears a stalled number by itself, so a wrong value can't stay on the screen", () => {
    vi.useFakeTimers();
    const shown: (string | null)[] = [];
    startCountUp({ from: 0, to: 9, decimals: 0, seconds: 0.5, show: (text) => shown.push(text), animate: stalled(0) });
    expect(shown).toEqual(["0"]);
    vi.advanceTimersByTime(700);
    expect(shown.at(-1)).toBeNull();
  });

  it("clears as soon as a normal animation finishes", () => {
    const shown: (string | null)[] = [];
    startCountUp({
      from: 1,
      to: 2,
      decimals: 2,
      seconds: 0.5,
      show: (text) => shown.push(text),
      animate: (_from, _to, options) => {
        options.onUpdate(1.5);
        options.onComplete();
        return { stop: () => {} };
      },
    });
    expect(shown).toEqual(["1.50", null]);
  });

  it("stopping early leaves nothing running", () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    const shown: (string | null)[] = [];
    const cancel = startCountUp({ from: 0, to: 1, decimals: 0, seconds: 0.5, show: (text) => shown.push(text), animate: () => ({ stop }) });
    cancel();
    expect(stop).toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(shown).toEqual([]);
  });
});

describe("stat tiles", () => {
  it("show what they're given, and nothing invented", () => {
    const html = renderToStaticMarkup(<StatTile label="Blocked" value="–" />);
    expect(html).toContain("–");
    expect(html).not.toContain(">0<");
  });
});
