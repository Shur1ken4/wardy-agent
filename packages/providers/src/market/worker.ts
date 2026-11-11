// Takes a hire from the Agent Market and does the one job Wardy Agent sells: a check of a payee. The brief is untrusted
// text written by whoever posted the job. It's read for a payee and an amount with strict patterns, and never as
// instructions. The deliverable is the signed verdict's public part, and a link where anyone can verify it.
import { isValidNearAccount, type Verdict } from "@wardy-agent/core";
import { randomUUID } from "node:crypto";
import type { AgentMarketLike, AssignmentItem } from "./agentMarket.js";
import type { EarningsLog } from "./earnings.js";

export interface CheckRequest {
  requestId: string;
  agentId: string;
  ownerId: string;
  payee: string;
  chain: string;
  asset: string;
  amount: string;
  purpose: string;
  createdAt: string;
}

export interface MarketWorkerOptions {
  market: AgentMarketLike;
  earnings: EarningsLog;
  /** Runs a check and signs the verdict. It can never move money: a check is a question. */
  check(request: CheckRequest): Promise<Verdict>;
  /** Where a buyer verifies the verdict's signature, such as https://wardy-agent.fly.dev. */
  publicUrl: string;
  now?: () => Date;
  log?: (line: string) => void;
}

/** What the brief asks about, read with patterns only. Nothing else in the brief is used. */
export interface BriefAsk {
  payee: string;
  chain: string;
  amount: string;
  asset: string;
}

const LABELLED = (label: string) => new RegExp(`^\\s*${label}\\s*[:=]\\s*(\\S+)`, "im");
const NEAR_NAME = /\b[a-z0-9]([a-z0-9_-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9_-]*[a-z0-9])?)*\.(near|testnet)\b/g;
const AMOUNT = /\b(\d{1,12}(?:\.\d{1,12})?)\s*(wNEAR|NEAR|USDC)\b/i;

/** A `payee:` line wins. Otherwise exactly one account name in the brief is taken as the payee. Two or none is a question back. */
export function readBrief(description: string): BriefAsk | null {
  const labelled = description.match(LABELLED("payee"))?.[1]?.trim().toLowerCase();
  const found = [...new Set([...description.toLowerCase().matchAll(NEAR_NAME)].map((match) => match[0]))];
  const payee = labelled ?? (found.length === 1 ? found[0] : undefined);
  if (!payee || !isValidNearAccount(payee)) return null;
  const chain = description.match(LABELLED("chain"))?.[1]?.trim().toLowerCase() ?? "near";
  const amountLine = description.match(LABELLED("amount"))?.[1]?.trim() ?? description.match(AMOUNT)?.[1];
  const amount = amountLine && /^\d{1,12}(\.\d{1,12})?$/.test(amountLine) ? amountLine : "1";
  const assetWord = (description.match(LABELLED("asset"))?.[1] ?? description.match(AMOUNT)?.[2] ?? "wNEAR").trim();
  const asset = /usdc/i.test(assetWord) ? "USDC" : "wNEAR";
  return { payee, chain, amount, asset };
}

export const ASK_BACK =
  "Wardy Agent checks one payee per job. Please tell me the account to check, on its own line, like this:\n" +
  "payee: example.near\namount: 2 wNEAR (optional)\nNothing has been charged: the job hasn't been started.";

/** The deliverable. It names the payee and the verdict, and nothing from the brief beyond that. */
export function deliverable(ask: BriefAsk, verdict: Verdict, publicUrl: string): string {
  const next = verdict.decision === "ALLOW" ? "Nothing here says don't pay. That isn't proof it's safe: this check read the Wardy Network and public account facts, not your own payment history." : verdict.decision === "HOLD" ? "Something here is worth a person's look before paying." : "Don't pay this payee.";
  return [
    `# Wardy Agent check: ${verdict.decision}`,
    "",
    `**Payee:** \`${ask.payee}\` on ${ask.chain}, for ${ask.amount} ${ask.asset}`,
    `**Risk score:** ${verdict.riskScore} of 100`,
    "",
    next,
    "",
    "## Why",
    ...verdict.reasons.map((reason) => `- ${reason}`),
    "",
    "## Findings",
    ...verdict.signals.filter((signal) => signal.points > 0).map((signal) => `- \`${signal.code}\`: ${signal.message}`),
    "",
    "## Verify it",
    `This verdict is signed with ed25519 by key \`${verdict.wardyPublicKey}\`. Verdict id \`${verdict.verdictId}\`.`,
    `Check the signature: ${publicUrl}/v1/verdicts/${verdict.verdictId}/verify`,
    "",
    "This was a check. Nothing was paid, and Wardy Agent can't pay on your behalf from a check.",
  ].join("\n");
}

export class MarketWorker {
  constructor(private readonly options: MarketWorkerOptions) {}

  /** One pass: every hire not yet delivered is started, checked and submitted. Safe to call again and again. */
  async poll(): Promise<{ delivered: number; askedBack: number }> {
    const { market, earnings, log = () => undefined } = this.options;
    let delivered = 0;
    let askedBack = 0;
    for (const item of await market.myAssignments()) {
      const { assignment, job } = item;
      if (assignment.status !== "in_progress" || assignment.submittedAt || earnings.has(assignment.assignmentId)) continue;
      const ask = readBrief(job.description);
      if (!ask) {
        // Not started, so the buyer can still cancel for a full refund. Asked once: a second poll sees the same brief
        // and asks again only if the buyer hasn't written back.
        if (!item.latestMessage || item.latestMessage.senderSide !== "worker") {
          await market.message(assignment.assignmentId, ASK_BACK);
          askedBack += 1;
          log(`asked back on ${assignment.assignmentId}: no payee in the brief`);
        }
        continue;
      }
      if (!assignment.startedAt) await market.start(assignment.assignmentId);
      const verdict = await this.options.check({
        requestId: randomUUID(),
        agentId: "agent-market",
        ownerId: `market-job-${job.jobId}`,
        payee: ask.payee,
        chain: ask.chain,
        asset: ask.asset,
        amount: ask.amount,
        purpose: `Agent Market job ${job.jobId}`,
        createdAt: (this.options.now?.() ?? new Date()).toISOString(),
      });
      await market.submit(assignment.assignmentId, deliverable(ask, verdict, this.options.publicUrl));
      earnings.record({
        assignmentId: assignment.assignmentId,
        jobId: job.jobId,
        amount: assignment.escrowAmount,
        currency: assignment.escrowToken,
        verdictId: verdict.verdictId,
        deliveredAt: (this.options.now?.() ?? new Date()).toISOString(),
      });
      delivered += 1;
      log(`delivered ${verdict.decision} for ${ask.payee} on ${assignment.assignmentId} (${assignment.escrowAmount} ${assignment.escrowToken})`);
    }
    return { delivered, askedBack };
  }
}
