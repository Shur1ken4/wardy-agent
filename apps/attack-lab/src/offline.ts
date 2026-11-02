// The offline run: scripted agent, recorded AI answers if there are any, one audit chain. Same bytes every time.
import { rmSync } from "node:fs";
import { AuditLog, ReportStore } from "@wardy-agent/core";
import { loadScenarios } from "@wardy-agent/demo-agent";
import { MockContextAnalyzer, RECORDED_AI_FINDINGS } from "@wardy-agent/providers";
import { fileURLToPath } from "node:url";
import { type LabRun, runLab } from "./lab.js";
import { RESULTS_DIR, type ResultsMeta, writeResults } from "./results.js";

export const HOLDOUT_DIR = fileURLToPath(new URL("../holdout/", import.meta.url));

function aiSource(recorded: boolean): string {
  return recorded
    ? "real answers recorded from NEAR AI Cloud and replayed here. A replay can't be attested, so verdicts here say `attested: false`."
    : "not run. No real answers have been recorded yet, and made-up ones wouldn't mean anything, so only the built-in rules read the text. Every decision below stands without the AI.";
}

export interface OfflineRun {
  run: LabRun;
  holdout: LabRun;
  meta: ResultsMeta;
}

/** Writes nothing unless `auditPath` is given. */
export async function runOffline(options: { auditPath?: string } = {}): Promise<OfflineRun> {
  if (options.auditPath) rmSync(options.auditPath, { force: true });
  const audit = new AuditLog(options.auditPath);
  const aiRecorded = Object.keys(RECORDED_AI_FINDINGS).length > 0;
  const shared = {
    agent: "scripted" as const,
    aiRecorded,
    analyzer: new MockContextAnalyzer(RECORDED_AI_FINDINGS),
    audit,
    network: new ReportStore(),
  };
  const run = await runLab(loadScenarios(), shared);
  // Its own network: a holdout attack shouldn't get help from reports the main set produced.
  const holdout = await runLab(loadScenarios(HOLDOUT_DIR), { ...shared, network: new ReportStore() });
  return { run, holdout, meta: { agent: "scripted", aiSource: aiSource(aiRecorded) } };
}

export async function runAndWriteOffline(): Promise<OfflineRun> {
  const result = await runOffline({ auditPath: `${RESULTS_DIR}/audit.jsonl` });
  writeResults(result.run, result.meta, result.holdout, "latest");
  return result;
}
