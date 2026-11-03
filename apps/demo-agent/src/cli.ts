// `npm run agent -- --scenario lookalike`: prints what the gullible agent read, what it asked Wardy Agent, and the
// answer. If `npm run dev` is running, it uses that server, so the dashboard shows it. If not, it starts its own.
// Add --llm to let a real model decide (needs NEAR_AI_CLOUD_API_KEY).
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, OFFLINE_AGENT_TOKEN, wire } from "@wardy-agent/api";
import { type AgentEvent, type PayArgs, type PayTool, runLlmAgent, runScriptedAgent } from "./agent.js";
import { loadScenarios, type Scenario } from "./scenario.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const args = process.argv.slice(2);
const flagValue = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const scenarios = loadScenarios();

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function pick(): Scenario {
  const wanted = flagValue("--scenario");
  const list = scenarios.map((scenario) => `  ${scenario.slug.padEnd(20)} ${scenario.id} ${scenario.title}`).join("\n");
  if (!wanted) fail(`Choose one with --scenario:\n${list}`);
  const found = scenarios.find((scenario) => scenario.slug === wanted || scenario.id.toLowerCase() === wanted.toLowerCase());
  return found ?? fail(`No scenario called "${wanted}". Choose from:\n${list}`);
}

function indent(text: string) {
  return text.trim().split("\n").map((line) => `    ${line}`).join("\n");
}

function printEvent(event: AgentEvent) {
  if (event.type === "read") console.log(`\nThe agent read ${event.file}:\n${indent(event.text)}`);
  if (event.type === "says") console.log(`\nThe agent says:\n${indent(event.text)}`);
  if (event.type === "ask") console.log(`\nThe agent asked Wardy Agent to pay ${event.args.amount} ${event.args.asset} to ${event.args.payee}.`);
  if (event.type === "answer") console.log(`\nWardy Agent's answer:\n${indent(event.text)}`);
}

const scenario = pick();
console.log(`${scenario.id}: ${scenario.title}\n${scenario.setup}`);

const sharedUrl = process.env.WARDY_API_URL || `http://127.0.0.1:${process.env.WARDY_API_PORT || 8787}`;
const running = await fetch(`${sharedUrl}/health`, { signal: AbortSignal.timeout(1000) }).then(
  (response) => response.ok,
  () => false,
);

let apiUrl = sharedUrl;
let agentToken = process.env.WARDY_AGENT_TOKEN || OFFLINE_AGENT_TOKEN;
let ownerId = process.env.WARDY_OWNER_ID || process.env.AGENT_OWNER_ACCOUNT_ID || "demo-owner.near";
let cleanup = async () => {};
// On a shared server this scenario may have run before, so each run needs its own invoice to be a fresh one.
const runTag = running ? `-${Date.now().toString(36)}` : "";

if (running) {
  console.log(`\nUsing the server already running at ${sharedUrl}, so it appears on the dashboard. Approval links print in that server's terminal.`);
} else {
  const dataDir = mkdtempSync(join(tmpdir(), "wardy-agent-demo-"));
  const wiring = await wire({ WARDY_MODE: "offline" }, { dataDir });
  wiring.service.on("hold", ({ approvalUrl }) => console.log(`\nThe owner, and only the owner, gets this link: ${approvalUrl}`));
  const app = await buildApp({ service: wiring.service, network: wiring.network, agentToken: wiring.agentToken, ownerToken: wiring.ownerToken, mode: "offline" });
  apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  agentToken = wiring.agentToken;
  ownerId = wiring.service.fleetOwnerId;
  cleanup = async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  console.log("\nNo server running, so this uses a temporary offline one: mock ledger, no keys.");
}

const otherOwner = scenario.owner === "other";
const pay: PayTool = async (request: PayArgs) => {
  const context = request.context && runTag && request.context.invoiceText ? { ...request.context, invoiceText: `${request.context.invoiceText}\nRef ${runTag}` } : request.context;
  const response = await fetch(`${apiUrl}${otherOwner ? "/v1/check" : "/v1/pay"}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      agentId: otherOwner ? "agent-b" : "procure-bot",
      ownerId: otherOwner ? "other-owner.near" : ownerId,
      chain: "near",
      createdAt: new Date().toISOString(),
      ...request,
      purpose: request.purpose || "not stated",
      ...(request.invoiceId ? { invoiceId: `${request.invoiceId}${runTag}` } : {}),
      ...(context ? { context } : {}),
    }),
  });
  const body = (await response.json()) as { decision?: string; reasons?: string[]; execution?: { status?: string; txHash?: string }; error?: string; message?: string };
  if (!response.ok) return { text: `Refused (${body.error}): ${(body.message ?? "invalid request").replace(/\.$/, "")}. Nothing was paid.${response.status === 401 ? ` A different Wardy Agent is already running at ${sharedUrl}. Stop it, or set WARDY_AGENT_TOKEN to match it.` : ""}` };
  const paid = body.execution?.txHash ? `\nPaid: ${body.execution.txHash}` : "";
  return { text: `${body.decision}${body.execution?.status ? `, ${body.execution.status}` : ""}${paid}\n${(body.reasons ?? []).join("\n")}` };
};

try {
  if (args.includes("--llm")) {
    const apiKey = process.env.NEAR_AI_CLOUD_API_KEY ?? fail("--llm needs NEAR_AI_CLOUD_API_KEY. See Step 1 of docs/SETUP_FOR_SHURIK.md.");
    await runLlmAgent(
      scenario,
      pay,
      "wardy_pay",
      {
        apiKey,
        model: process.env.NEAR_AI_MODEL || "z-ai/glm-5.3-flash",
        ...(process.env.NEAR_AI_CLOUD_BASE_URL ? { baseUrl: process.env.NEAR_AI_CLOUD_BASE_URL } : {}),
      },
      printEvent,
    );
  } else {
    await runScriptedAgent(scenario, pay, printEvent);
  }
} finally {
  await cleanup();
}
