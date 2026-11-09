// The owner's account on a hosted server: every tick and number is from the server, and a hostile account name stays text.
import type { OwnerPolicy } from "@wardy-agent/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { agentWords, budgetShare, gettingStarted, type OwnerMe, spentOfBudget } from "../src/lib/account";
import type { Stats } from "../src/lib/api";
import { type Dashboard, DashboardContext } from "../src/lib/dashboard";
import { Account } from "../src/screens/Account";

const policy = { maxPerPayment: "0.02", dailyBudget: "0.1", approvalThreshold: "0.01", allowedAssets: ["nep141:wrap.near"], askForNewPayees: true, frozen: false, nativeNearTransfers: false } as unknown as OwnerPolicy;
const owner = (agent: OwnerMe["agent"] = {}, ownerId = "alice.near"): OwnerMe => ({ kind: "owner", ownerId, signedUpAt: "2026-11-09T10:00:00.000Z", agent, signInAvailable: true });
const stats = (spentLast24h: Stats["spentLast24h"]): Stats => ({ checkedToday: 3, blockedToday: 1, heldNow: 1, paidToday: 1, saved: [], spentLast24h, checksForOthers: 0, earned: { checksSold: 0, revenue: [] } });

const render = (value: Partial<Dashboard>) =>
  renderToStaticMarkup(
    <DashboardContext.Provider value={{ policy: { policy, provider: "outlayer-testnet", whoCanSpend: "", ownerId: "alice.near" }, stats: null, verdicts: [], account: null, signOut: () => {}, refresh: async () => {}, ...value } as Dashboard}>
      <Account />
    </DashboardContext.Provider>,
  );

describe("the account's numbers", () => {
  it("counts only the asset the policy allows, the way the daily budget does", () => {
    expect(spentOfBudget(stats([{ asset: "nep141:wrap.near", amount: "0.03" }, { asset: "nep141:other", amount: "9" }]), policy)).toBe("0.03");
    expect(spentOfBudget(stats([]), policy)).toBe("0");
    expect(spentOfBudget(null, policy)).toBe("0");
  });

  it("the bar never runs past full or below empty", () => {
    expect(budgetShare("0.05", "0.1")).toBe(0.5);
    expect(budgetShare("5", "0.1")).toBe(1);
    expect(budgetShare("1", "0")).toBe(0);
  });

  it("calls an agent connected only once the server has seen it call", () => {
    expect(agentWords(owner()).state).toBe("none");
    expect(agentWords(owner({ tokenMadeAt: "2026-11-09T10:00:00.000Z" })).state).toBe("waiting");
    expect(agentWords(owner({ tokenMadeAt: "2026-11-09T10:00:00.000Z", lastSeenAt: "2026-11-09T11:00:00.000Z" })).state).toBe("connected");
  });

  it("ticks each first step only when it really happened", () => {
    expect(gettingStarted(owner(), false).map((step) => step.done)).toEqual([true, false, false, false]);
    expect(gettingStarted(owner({ tokenMadeAt: "x", lastSeenAt: "y" }), true).map((step) => step.done)).toEqual([true, true, true, true]);
  });
});

describe("Your account", () => {
  it("shows the limits and what was spent, and says it's testnet", () => {
    const html = render({ account: owner(), stats: stats([{ asset: "nep141:wrap.near", amount: "0.015" }]) });
    expect(html).toContain("alice.near");
    expect(html).toContain("0.015 of 0.1");
    expect(html).toContain("testnet");
    expect(html).toContain("Make an agent token");
  });

  it("a visitor in a sandbox is asked to sign in, and sees no one's account", () => {
    const html = render({ account: { kind: "sandbox", signInAvailable: true } });
    expect(html).toContain("Sign in with NEAR");
    expect(html).not.toContain("alice.near");
  });

  it("an account name can't become markup", () => {
    const html = render({ account: owner({}, '<img src=x onerror="alert(1)">') });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
