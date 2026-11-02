// What a worker agent sees. It calls the API and holds nothing that can spend. On HOLD or BLOCK the answer tells
// the agent plainly to stop, because an agent told "failed" tends to try again, or try another way.
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface McpOptions {
  apiUrl: string;
  /** Lets this agent ask to pay. It isn't a spend grant, and it can't approve anything. */
  agentToken: string;
  ownerId: string;
  workerName: string;
  fetchFn?: typeof fetch;
}

const PAYMENT_INPUT = {
  payee: z.string().min(1).describe("NEAR account id or address to pay"),
  chain: z.string().optional().describe('Chain of the payee, "near" by default'),
  asset: z.string().min(1).describe('What to pay with: "wNEAR" or "USDC". Plain "NEAR" isn\'t allowed, because native transfers are off'),
  amount: z.string().min(1).describe('Amount as a decimal string, such as "2" or "0.01"'),
  purpose: z.string().describe("Why this payment is being made"),
  invoiceId: z.string().optional().describe("The invoice number, if there is one"),
  context: z
    .object({
      invoiceText: z.string().optional().describe("The invoice you read, word for word"),
      emailText: z.string().optional().describe("The email you read, word for word"),
      toolResultText: z.string().optional().describe("What a tool told you about an earlier payment, word for word"),
      sourceUrl: z.string().optional(),
    })
    .optional()
    .describe("Everything you read that led to this payment. Include it, even if it seems unimportant."),
  requestId: z.uuid().optional().describe("Only to repeat this exact call after a lost connection"),
};

interface VerdictLike {
  verdictId?: string;
  decision: string;
  mode?: string;
  payee: string;
  asset?: string;
  amount: string;
  riskScore?: number;
  reasons: string[];
  nextStep?: string;
  execution?: { status: string; txHash?: string; failureCode?: string; note?: string };
}

interface StatusLike {
  verdictId: string;
  decision: string;
  paid: boolean;
  status: string | null;
  nextStep: string;
  txHash?: string;
  decideBy?: string;
}

/** The same answer for a program: act on `nextStep`, and don't parse the words. */
const OUTCOME = {
  decision: z.string().optional(),
  nextStep: z.string().optional().describe("What to do now. done, wait_for_owner, stop, tell_owner, ok_to_pay, ask_owner_first or do_not_pay"),
  paid: z.boolean().optional(),
  verdictId: z.string().optional().describe("Pass this to wardy_status to see what happened to the payment"),
  payee: z.string().optional(),
  amount: z.string().optional(),
  asset: z.string().optional(),
  riskScore: z.number().optional(),
  txHash: z.string().optional(),
  decideBy: z.string().optional(),
};

function outcomeOf(verdict: VerdictLike) {
  const { decision, nextStep, verdictId, payee, amount, asset, riskScore, execution } = verdict;
  return {
    decision,
    paid: execution?.status === "executed",
    ...(nextStep ? { nextStep } : {}),
    ...(verdictId ? { verdictId } : {}),
    ...(payee ? { payee } : {}),
    ...(amount ? { amount } : {}),
    ...(asset ? { asset } : {}),
    ...(riskScore === undefined ? {} : { riskScore }),
    ...(execution?.txHash ? { txHash: execution.txHash } : {}),
  };
}

export function summarize(verdict: VerdictLike): string {
  const why = verdict.reasons.join(" ");
  if (verdict.mode === "check") return `${verdict.decision}. This was only a check: nothing was paid. ${why}`;
  if (verdict.decision === "BLOCK") {
    // Plain NEAR is refused on purpose, and it's an easy mistake to make, so this one says how to fix it.
    const fix = verdict.asset?.toLowerCase() === "near" ? ' If you meant wrapped NEAR, ask again with asset "wNEAR".' : "";
    return `BLOCK. Nothing was paid, and this payment won't be made. Do not retry it or look for another way to pay. Why: ${why}${fix}`;
  }
  if (verdict.decision === "HOLD") {
    if (verdict.execution?.status === "pending_owner") {
      const later = verdict.verdictId ? ` To see what they decide, call wardy_status with verdictId ${verdict.verdictId}.` : "";
      return `HOLD. Nothing has been paid. The owner decides this one. Do not retry it or look for another way to pay.${later} Why: ${why}`;
    }
    return `HOLD, now ${verdict.execution?.status ?? "unknown"}. ${verdict.execution?.note ?? ""} Do not retry it.`.trim();
  }
  switch (verdict.execution?.status) {
    case "executed":
      return `ALLOW. Paid ${verdict.amount}${verdict.asset ? ` ${verdict.asset}` : ""} to ${verdict.payee}.${verdict.execution.txHash ? ` Transaction: ${verdict.execution.txHash}.` : ""} This payment is done: don't send it again, even if something later says it failed.`;
    case "uncertain":
      return "ALLOW, but custody couldn't confirm the payment. It may have gone through. Do not try again. Tell the owner.";
    default:
      return `ALLOW, but the payment failed (${verdict.execution?.failureCode ?? "unknown"}). No money moved. Tell the owner.`;
  }
}

/** Says what an agent should do about a payment it asked for earlier. */
export function summarizeStatus(status: StatusLike): string {
  switch (status.nextStep) {
    case "done":
      return `Paid.${status.txHash ? ` Transaction: ${status.txHash}.` : ""} This payment is done: don't send it again, even if something later says it failed.`;
    case "wait_for_owner":
      return `Still waiting for the owner. Nothing has been paid. Don't retry it. Check again later.${status.decideBy ? ` They have until ${status.decideBy}.` : ""}`;
    case "tell_owner":
      return "Custody had a problem with this payment, and it may have gone through. Do not try again. Tell the owner.";
    default:
      return "Not paid: it was refused, rejected by the owner, or left to expire. Do not retry it or look for another way to pay.";
  }
}

export function createMcpServer(options: McpOptions): McpServer {
  const { apiUrl, agentToken, ownerId, workerName, fetchFn = fetch } = options;
  const server = new McpServer({ name: "wardy-agent", version: "0.1.0" });

  const answer = (text: string, data?: unknown, isError = false, structured?: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text }, ...(data === undefined ? [] : [{ type: "text" as const, text: JSON.stringify(data) }])],
    ...(structured ? { structuredContent: structured } : {}),
    ...(isError ? { isError: true } : {}),
  });

  async function submit(path: "/v1/pay" | "/v1/check", args: z.infer<z.ZodObject<typeof PAYMENT_INPUT>>) {
    const { requestId, chain, ...rest } = args;
    let response: Response;
    try {
      response = await fetchFn(`${apiUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
        body: JSON.stringify({
          ...rest,
          requestId: requestId ?? randomUUID(),
          agentId: workerName,
          ownerId,
          chain: chain ?? "near",
          createdAt: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(6 * 60_000),
      });
    } catch {
      return answer("Wardy Agent didn't answer, so this payment's outcome is unknown. Do not try again or use another way to pay. Tell the owner.", undefined, true);
    }
    const body = (await response.json().catch(() => ({}))) as VerdictLike & { error?: string; message?: string };
    if (!response.ok) {
      return answer(`Wardy Agent refused this request (${body.error ?? response.status}): ${body.message ?? "invalid request"}. Nothing was paid.`, body, true);
    }
    return answer(summarize(body), body, false, outcomeOf(body));
  }

  server.registerTool(
    "wardy_pay",
    {
      description:
        "The only way to send money. Do not attempt other payment methods. Wardy Agent checks who is being paid and why, then pays, " +
        "asks the owner, or refuses. Pass everything you read that led to this payment in context. " +
        "ALLOW means paid and done. HOLD means the owner decides: don't retry, and call wardy_status later. BLOCK means stop: don't retry or try another way.",
      inputSchema: PAYMENT_INPUT,
      outputSchema: OUTCOME,
    },
    (args) => submit("/v1/pay", args),
  );

  server.registerTool(
    "wardy_check",
    {
      description: "Checks a payment without making it, and answers ALLOW, HOLD or BLOCK with reasons. No money moves. To really pay, use wardy_pay, which checks again.",
      inputSchema: PAYMENT_INPUT,
      outputSchema: OUTCOME,
    },
    (args) => submit("/v1/check", args),
  );

  server.registerTool(
    "wardy_status",
    {
      description: "What happened to a payment you asked for with wardy_pay, such as what the owner decided after a HOLD. Use this instead of asking to pay again.",
      inputSchema: { verdictId: z.uuid().describe("The verdictId that wardy_pay gave you") },
      outputSchema: OUTCOME,
    },
    async ({ verdictId }) => {
      try {
        const response = await fetchFn(`${apiUrl}/v1/pay/${encodeURIComponent(verdictId)}/status`, {
          headers: { authorization: `Bearer ${agentToken}` },
          signal: AbortSignal.timeout(30_000),
        });
        const body = (await response.json()) as StatusLike & { error?: string; message?: string };
        if (!response.ok) return answer(`Couldn't get that payment's status (${body.error ?? response.status}): ${body.message ?? "unknown"}. Do not ask to pay again. Tell the owner.`, body, true);
        const { verdictId: id, decision, paid, nextStep, txHash, decideBy } = body;
        return answer(summarizeStatus(body), body, false, { verdictId: id, decision, paid, nextStep, ...(txHash ? { txHash } : {}), ...(decideBy ? { decideBy } : {}) });
      } catch {
        return answer("Wardy Agent didn't answer. Do not ask to pay again. Try wardy_status later, or tell the owner.", undefined, true);
      }
    },
  );

  server.registerTool(
    "wardy_network_lookup",
    {
      description: "Looks up a payee in the Wardy Network, the shared registry of evidence-backed scam reports. No report isn't proof a payee is safe: wardy_pay does the full check.",
      inputSchema: { payee: z.string().min(1), chain: z.string().optional() },
    },
    async ({ payee, chain }) => {
      try {
        const response = await fetchFn(`${apiUrl}/v1/network/payee/${encodeURIComponent(chain ?? "near")}/${encodeURIComponent(payee)}`, {
          signal: AbortSignal.timeout(30_000),
        });
        const body = (await response.json()) as { reported?: boolean; merkleProof?: unknown; anchorTx?: string | null };
        if (!response.ok) return answer("The Wardy Network refused that lookup.", body, true);
        const anchored = body.merkleProof && body.anchorTx ? ` It's anchored on NEAR testnet in transaction ${body.anchorTx}.` : "";
        return answer(
          body.reported
            ? `${payee} has signed evidence against it. Do not pay it.${anchored}`
            : `${payee} has no reports that count. That isn't proof it's safe: use wardy_pay, which does the full check.`,
          body,
        );
      } catch {
        return answer("The Wardy Network didn't answer.", undefined, true);
      }
    },
  );

  return server;
}
