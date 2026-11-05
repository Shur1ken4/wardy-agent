// `npm run live:pay`: the real thing, once, on purpose. Wardy Agent checks a tiny payment to our own test merchant and
// pays through real custody only if the check and the owner allow it. It spends real wNEAR, so a person runs it and
// answers each question. The amounts are fixed here, and the verdicts stay in .data/live for the dashboard to show.
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { buildApp, wire, type Wiring } from "@wardy-agent/api";

export const FIRST_AMOUNT = "0.01";
export const SECOND_AMOUNT = "0.005";

export interface LivePayOptions {
  wiring: Wiring;
  payee: string;
  ask: (question: string) => Promise<string>;
  log?: (line: string) => void;
}

export type LivePayOutcome = "done" | "stopped" | "unexpected";

/** Each step ends with what really happened. Anything that isn't plainly paid or plainly refused stops the run. */
export async function runLivePayment({ wiring, payee, ask, log = console.log }: LivePayOptions): Promise<LivePayOutcome> {
  const { service, agentToken, ownerToken } = wiring;
  let approvalUrl = "";
  service.on("hold", (hold) => {
    approvalUrl = hold.approvalUrl; // The owner's link. The agent's reply never contains it, and it isn't printed.
  });
  const app = await buildApp({ service, network: wiring.network, agentToken, ownerToken, mode: wiring.mode });

  const post = async (url: string, payload: unknown, token?: string) => {
    const response = await app.inject({ method: "POST", url, payload: payload as object, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
    return { status: response.statusCode, body: response.json() as any };
  };

  const pay = (amount: string, invoiceId: string) =>
    post(
      "/v1/pay",
      {
        requestId: crypto.randomUUID(),
        agentId: "live-test-agent",
        ownerId: service.fleetOwnerId,
        payee,
        asset: "wNEAR",
        amount,
        purpose: `Live test: pay our own test merchant, ${invoiceId}`,
        invoiceId,
        context: { invoiceText: `Invoice ${invoiceId} for ${amount} wNEAR. Thanks for your business.` },
        createdAt: new Date().toISOString(),
      },
      agentToken,
    );

  const show = (verdict: any) => {
    log(`  Decision:  ${verdict.decision}, risk score ${verdict.riskScore}`);
    for (const reason of verdict.reasons) log(`  Reason:    ${reason}`);
    log(`  Private AI: ${verdict.ai?.attested ? "ran, attestation verified" : "no verified attestation for this payment"}`);
  };

  /** True only when the money plainly went. */
  const reportPayment = (verdict: any): boolean => {
    const { status, reference, txHash, failureCode } = verdict.execution;
    log(`  Payment:   ${status}${failureCode ? ` (${failureCode})` : ""}`);
    if (reference) log(`  Operation: ${reference}`);
    if (txHash) log(`  Transaction: https://near.rocks/tx/${txHash}`);
    if (status === "uncertain") log("  The payment may or may not have gone through. DON'T run this again. Tell Claude first.");
    return status === "executed";
  };

  const settle = async (first: { status: number; body: any }): Promise<any | null> => {
    if (first.status !== 200) {
      log(`  The API refused the request (HTTP ${first.status}): ${first.body.message ?? first.body.error ?? "no reason given"}`);
      return null;
    }
    show(first.body);
    if (first.body.decision !== "HOLD") return first.body;
    const answer = (await ask('\nWardy Agent is asking you, the owner. Type "approve" to pay or "reject" to refuse: ')).trim().toLowerCase();
    const action = answer === "approve" ? "approve" : "reject";
    const token = new URLSearchParams(new URL(approvalUrl).hash.slice(1)).get("token");
    const decided = await post(`/v1/approve/${first.body.verdictId}`, { action, ownerToken: token });
    if (decided.status !== 200) {
      log(`  The approval failed (HTTP ${decided.status}): ${decided.body.message ?? decided.body.error ?? "no reason given"}`);
      return null;
    }
    return decided.body;
  };

  try {
    log(`Wardy Agent live payment (${wiring.mode}, custody: ${service.providerName})`);
    log(`Payee: ${payee}\n`);

    log(`Payment 1: ${FIRST_AMOUNT} wNEAR. Nothing moves unless the check and you allow it.`);
    const first = await settle(await pay(FIRST_AMOUNT, "LIVE-1"));
    if (!first) return "unexpected";
    const firstPaid = reportPayment(first);
    if (!firstPaid) {
      log("\nStopped: the first payment wasn't paid, so there's no second one.");
      return first.execution.status === "refused" ? "stopped" : "unexpected";
    }

    log(`\nPayment 2: ${SECOND_AMOUNT} wNEAR to the same payee, now one you've paid. If the check allows it, it pays with no human.`);
    const go = (await ask('Type "yes" to continue, anything else to finish here: ')).trim().toLowerCase();
    if (go !== "yes") {
      log("Finished after one payment.");
      return "stopped";
    }
    const second = await settle(await pay(SECOND_AMOUNT, "LIVE-2"));
    if (!second) return "unexpected";
    const secondPaid = reportPayment(second);
    if (!secondPaid) return second.execution.status === "refused" ? "stopped" : "unexpected";

    log(`\nDone. Second payment: ${second.decision}${second.decision === "ALLOW" ? ", paid with no human" : ""}.`);
    return "done";
  } finally {
    await app.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const payee = process.env.DEMO_MERCHANT_ACCOUNT_ID;
  if (!payee) {
    console.error("DEMO_MERCHANT_ACCOUNT_ID is empty. Run: npm run setup:keys");
    process.exit(1);
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`This spends real wNEAR from the agent: at most ${FIRST_AMOUNT} + ${SECOND_AMOUNT}, to our own test merchant:\n  ${payee}`);
    const answer = await prompt.question('Type "yes" to start: ');
    if (answer.trim().toLowerCase() !== "yes") {
      console.log("Stopped. Nothing was done.");
      process.exit(0);
    }
    const wiring = await wire({ ...process.env, WARDY_MODE: "live" });
    const outcome = await runLivePayment({ wiring, payee, ask: (question) => prompt.question(question) });
    console.log(`\nVerdicts are in ${wiring.dataDir}. To check the records: npm run verify-audit -- ${wiring.dataDir}/audit.jsonl`);
    process.exitCode = outcome === "unexpected" ? 1 : 0;
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  } finally {
    prompt.close();
  }
}
