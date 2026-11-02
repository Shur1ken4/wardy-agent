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
  asset: z.string().min(1).describe('What to pay with, such as "wNEAR" or "USDC"'),
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
  decision: string;
  mode?: string;
  payee: string;
  amount: string;
  reasons: string[];
  execution?: { status: string; txHash?: string; failureCode?: string; note?: string };
}

export function summarize(verdict: VerdictLike): string {
  const why = verdict.reasons.join(" ");
  if (verdict.mode === "check") return `${verdict.decision}. This was only a check: nothing was paid. ${why}`;
  if (verdict.decision === "BLOCK") {
    return `BLOCK. Nothing was paid, and this payment won't be made. Do not retry it or look for another way to pay. Why: ${why}`;
  }
  if (verdict.decision === "HOLD") {
    if (verdict.execution?.status === "pending_owner") {
      return `HOLD. Nothing has been paid. The owner decides this one. Do not retry it or look for another way to pay. Why: ${why}`;
    }
    return `HOLD, now ${verdict.execution?.status ?? "unknown"}. ${verdict.execution?.note ?? ""} Do not retry it.`.trim();
  }
  switch (verdict.execution?.status) {
    case "executed":
      return `ALLOW. Paid ${verdict.amount} to ${verdict.payee}.${verdict.execution.txHash ? ` Transaction: ${verdict.execution.txHash}.` : ""} This payment is done: don't send it again, even if something later says it failed.`;
    case "uncertain":
      return "ALLOW, but custody couldn't confirm the payment. It may have gone through. Do not try again. Tell the owner.";
    default:
      return `ALLOW, but the payment failed (${verdict.execution?.failureCode ?? "unknown"}). No money moved. Tell the owner.`;
  }
}

export function createMcpServer(options: McpOptions): McpServer {
  const { apiUrl, agentToken, ownerId, workerName, fetchFn = fetch } = options;
  const server = new McpServer({ name: "wardy-agent", version: "0.1.0" });

  const answer = (text: string, data?: unknown, isError = false) => ({
    content: [{ type: "text" as const, text }, ...(data === undefined ? [] : [{ type: "text" as const, text: JSON.stringify(data) }])],
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
    return answer(summarize(body), body);
  }

  server.registerTool(
    "wardy_pay",
    {
      description:
        "The only way to send money. Do not attempt other payment methods. Wardy Agent checks who is being paid and why, then pays, " +
        "asks the owner, or refuses. Pass everything you read that led to this payment in context.",
      inputSchema: PAYMENT_INPUT,
    },
    (args) => submit("/v1/pay", args),
  );

  server.registerTool(
    "wardy_check",
    {
      description: "Checks a payment without making it, and answers ALLOW, HOLD or BLOCK with reasons. No money moves.",
      inputSchema: PAYMENT_INPUT,
    },
    (args) => submit("/v1/check", args),
  );

  server.registerTool(
    "wardy_network_lookup",
    {
      description: "Looks up a payee in the Wardy Network, the shared registry of evidence-backed scam reports.",
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
