// The card and notification for a payment waiting for the owner: only new holds raise one, and an agent's words stay text.
import type { VerdictView } from "@wardy-agent/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HoldAlert } from "../src/components/HoldAlert";
import { type Dashboard, DashboardContext, type Hold } from "../src/lib/dashboard";
import { holdAlertWords, newHolds, notifyPermission } from "../src/lib/holdAlerts";

const hold = (verdictId: string, payee = "wardy-agent-reporter.testnet"): Hold => ({
  verdict: { verdictId, payee, amount: "0.005", asset: "nep141:wrap.near", reasons: ["You asked to approve payees you haven't paid before."] } as unknown as VerdictView,
  expiresAt: "2026-11-10T23:00:00.000Z",
});

describe("which holds are new", () => {
  it("raises nothing for what was already waiting when the page opened", () => {
    expect(newHolds(null, [hold("a"), hold("b")])).toEqual([]);
  });

  it("raises only the holds that weren't there last time", () => {
    expect(newHolds(new Set(["a"]), [hold("b"), hold("a")]).map((h) => h.verdict.verdictId)).toEqual(["b"]);
    expect(newHolds(new Set(["a", "b"]), [hold("a")])).toEqual([]);
  });
});

describe("what the alert says", () => {
  it("names the amount, the payee and the first reason", () => {
    const words = holdAlertWords(hold("a"));
    expect(words.title).toBe("A payment is waiting for you");
    expect(words.body).toContain("wardy-agent-reporter.testnet");
    expect(words.body).toContain("haven't paid before");
  });

  it("without a browser, says notifications aren't available rather than failing", () => {
    expect(notifyPermission()).toBe("unsupported");
  });

  it("shows nothing until a new payment is waiting, so a page never opens on a stale card", () => {
    const html = renderToStaticMarkup(
      <DashboardContext.Provider value={{ holds: [hold("a", "<img src=x onerror=alert(1)>")], needsCredential: false, stats: null } as unknown as Dashboard}>
        <HoldAlert />
      </DashboardContext.Provider>,
    );
    expect(html).not.toContain("Waiting for you");
    expect(html).not.toContain("<img");
  });
});
