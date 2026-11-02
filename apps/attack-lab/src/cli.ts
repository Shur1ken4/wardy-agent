// `npm run attack-lab` runs every scenario with and without Wardy Agent and writes results. Offline, it needs nothing.
//   --llm     a real model as the agent, on NEAR AI Cloud. Needs NEAR_AI_CLOUD_API_KEY. Writes llm-latest.md.
//   --record  asks NEAR AI Cloud about each scenario's text and saves the answers, for offline replay.
// In every mode the payments stay on mock ledgers.
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AuditLog, contextDocument, PaymentRequestSchema, ReportStore, sha256Hex } from "@wardy-agent/core";
import { contextFrom, loadScenarios, type Scenario } from "@wardy-agent/demo-agent";
import { NearAiContextAnalyzer, type RecordedFinding } from "@wardy-agent/providers";
import { runLab, summaryLines } from "./lab.js";
import { HOLDOUT_DIR, runAndWriteOffline } from "./offline.js";
import { writeResults } from "./results.js";

const FINDINGS_FILE = fileURLToPath(new URL("../../../packages/providers/fixtures/ai-findings.json", import.meta.url));

if (existsSync(".env")) process.loadEnvFile(".env");

function nearAiSettings() {
  const apiKey = process.env.NEAR_AI_CLOUD_API_KEY;
  if (!apiKey) throw new Error("NEAR_AI_CLOUD_API_KEY is empty. See Step 1 of docs/SETUP_FOR_SHURIK.md.");
  return {
    apiKey,
    model: process.env.NEAR_AI_MODEL || "z-ai/glm-5.3-flash",
    ...(process.env.NEAR_AI_CLOUD_BASE_URL ? { baseUrl: process.env.NEAR_AI_CLOUD_BASE_URL } : {}),
  };
}

function printProblems(scenarios: { id: string; problems: string[] }[]): number {
  let problems = 0;
  for (const { id, problems: found } of scenarios) {
    for (const problem of found) {
      console.error(`UNEXPECTED ${id}: ${problem}`);
      problems += 1;
    }
  }
  return problems;
}

async function record() {
  const settings = nearAiSettings();
  const analyzer = new NearAiContextAnalyzer(settings);
  const recordings: Record<string, RecordedFinding & { scenario: string }> = {};
  const scenarios: Scenario[] = [...loadScenarios(), ...loadScenarios(HOLDOUT_DIR)];
  for (const scenario of scenarios) {
    for (const step of scenario.steps) {
      const context = contextFrom(scenario, step.reads);
      if (!context) continue;
      const document = contextDocument(
        PaymentRequestSchema.parse({
          requestId: crypto.randomUUID(),
          agentId: "recorder",
          ownerId: "recorder.near",
          payee: step.payee,
          asset: step.asset,
          amount: step.amount,
          purpose: step.purpose,
          context,
          createdAt: new Date().toISOString(),
        }),
      );
      const hash = sha256Hex(document);
      if (recordings[hash]) continue;
      const answer = await analyzer.analyze(document);
      if (!answer.findings) {
        console.log(`${scenario.id}: no usable answer, so nothing recorded for it.`);
        continue;
      }
      recordings[hash] = {
        scenario: scenario.id,
        findings: answer.findings,
        model: answer.model ?? settings.model,
        recordedAt: new Date().toISOString().slice(0, 10),
        chatId: answer.attestationRef ?? null,
        attested: answer.attested,
        attestationLevel: answer.attestationLevel ?? "none",
      };
      console.log(`${scenario.id}: recorded (attested: ${answer.attested}, level: ${answer.attestationLevel}).`);
    }
  }
  writeFileSync(FINDINGS_FILE, `${JSON.stringify(recordings, null, 2)}\n`);
  console.log(`\n${Object.keys(recordings).length} answers saved. Run npm run attack-lab -- --offline to use them.`);
}

async function llm() {
  const settings = nearAiSettings();
  const scenarios = loadScenarios();
  const run = await runLab(scenarios, {
    agent: "llm",
    llm: settings,
    analyzer: new NearAiContextAnalyzer(settings),
    aiRecorded: false,
    audit: new AuditLog(),
    network: new ReportStore(),
  });
  writeResults(run, { agent: "llm", aiSource: `live on NEAR AI Cloud, model \`${settings.model}\`.` }, undefined, "llm-latest");
  for (const line of summaryLines(run)) console.log(line);
  console.log("\nWritten to apps/attack-lab/results/llm-latest.md");
  return printProblems(run.scenarios);
}

async function main(): Promise<number> {
  const flags = new Set(process.argv.slice(2));
  if (flags.has("--record")) {
    await record();
    return 0;
  }
  if (flags.has("--llm")) return llm();
  const { run, holdout } = await runAndWriteOffline();
  for (const line of summaryLines(run)) console.log(line);
  if (holdout.scenarios.length > 0) {
    console.log("\nHoldout, written after the rules were frozen:");
    for (const line of summaryLines(holdout)) console.log(line);
  }
  console.log("\nWritten to apps/attack-lab/results/latest.md");
  // The holdout is measured, not expected: its misses are findings to report, not failures.
  return printProblems(run.scenarios);
}

main().then(
  (problems) => process.exit(problems > 0 ? 1 : 0),
  (error) => {
    console.error((error as Error).message);
    process.exit(1);
  },
);
