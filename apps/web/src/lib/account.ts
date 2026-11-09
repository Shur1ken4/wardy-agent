// A signed-in owner's account on a hosted server, in plain words. Every value comes from the server: nothing is guessed.
import type { OwnerPolicy } from "@wardy-agent/core";
import type { Me, Stats } from "./api";
import { dateTimeOf } from "./format";

export type OwnerMe = Extract<Me, { kind: "owner" }>;

/** Spent in the last 24 hours in the assets the policy allows: the number the daily budget is checked against. */
export function spentOfBudget(stats: Stats | null, policy: OwnerPolicy | undefined): string {
  if (!policy) return "0";
  const entries = (stats?.spentLast24h ?? []).filter((entry) => policy.allowedAssets.includes(entry.asset));
  if (entries.length === 0) return "0";
  // One allowed asset on a hosted server. With more, the largest is the one nearest its budget.
  return entries.map((entry) => entry.amount).sort((a, b) => Number(b) - Number(a))[0] ?? "0";
}

/** How far through the daily budget, 0 to 1, for the bar. */
export function budgetShare(spent: string, budget: string): number {
  const total = Number(budget);
  if (!(total > 0)) return 0;
  return Math.min(1, Math.max(0, Number(spent) / total));
}

/** The agent, as the owner should understand it. "Connected" means the server has really seen a call from it. */
export function agentWords(account: OwnerMe): { state: "none" | "waiting" | "connected"; text: string } {
  const { tokenMadeAt, lastSeenAt } = account.agent;
  if (!tokenMadeAt) return { state: "none", text: "No agent yet" };
  if (!lastSeenAt) return { state: "waiting", text: "Token made, no call yet" };
  return { state: "connected", text: `Last call ${dateTimeOf(lastSeenAt)}` };
}

export interface Step {
  title: string;
  done: boolean;
  detail: string;
}

/** How an owner starts using Wardy Agent, ticked off from what really happened. */
export function gettingStarted(account: OwnerMe, checkedAny: boolean): Step[] {
  return [
    { title: "Sign in with your NEAR wallet", done: true, detail: account.signedUpAt ? `Since ${dateTimeOf(account.signedUpAt)}` : "Done" },
    { title: "Make a token for your agent", done: Boolean(account.agent.tokenMadeAt), detail: "It lets your agent ask to pay. It can never approve or move money itself." },
    { title: "Connect your agent", done: Boolean(account.agent.lastSeenAt), detail: "Put the token in your agent's settings. This ticks when its first call arrives." },
    { title: "See its first payment checked", done: checkedAny, detail: "Every payment shows on Live checks: paid, held for you, or blocked." },
  ];
}
