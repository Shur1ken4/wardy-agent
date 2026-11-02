// The offline run: scripted agent, recorded AI answers if there are any, one audit chain. Same bytes every time.
import { rmSync, writeFileSync } from "node:fs";
import { AuditLog, ReportStore, serializeFeed } from "@wardy-agent/core";
import { loadScenarios } from "@wardy-agent/demo-agent";
import { MockContextAnalyzer, RECORDED_AI_FINDINGS } from "@wardy-agent/providers";
import { fileURLToPath } from "node:url";
import { formatAmounts, type LabRun, runLab } from "./lab.js";
import { RESULTS_DIR, type ResultsMeta, writeResults } from "./results.js";

export const HOLDOUT_DIR = fileURLToPath(new URL("../holdout/", import.meta.url));
/** The reports the main set produced, labelled as seed. Same bytes every time, so anyone can rebuild what was anchored. */
export const SEED_FEED_FILE = `${RESULTS_DIR}network-seed.jsonl`;

function aiSource(recorded: boolean): string {
  return recorded
    ? "real answers recorded from NEAR AI Cloud and replayed here. A replay can't be attested, so verdicts here say `attested: false`."
    : "not run. No real answers have been recorded yet, and made-up ones wouldn't mean anything, so only the built-in rules read the text. Every decision below stands without the AI.";
}

export interface OfflineRun {
  run: LabRun;
  holdout: LabRun;
  meta: ResultsMeta;
  /** The reports the main set produced. */
  network: ReportStore;
}

/** A plain statement of how the holdout went, computed from the run. */
export function holdoutLine(holdout: LabRun): string {
  const attacks = holdout.scenarios.filter((scenario) => scenario.kind === "attack");
  const missed = attacks.filter((scenario) => Object.keys(scenario.with.lost).length > 0);
  const honest = holdout.scenarios.length - attacks.length;
  return `Holdout, written after the rules froze: ${missed.length} of ${attacks.length} attacks still took money (${formatAmounts(holdout.totals.lostWith)}). Honest messages passed: ${holdout.totals.honestPassed}/${honest}.`;
}

/** Writes nothing unless `auditPath` is given. */
export async function runOffline(options: { auditPath?: string; holdoutDir?: string } = {}): Promise<OfflineRun> {
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
  const holdout = await runLab(loadScenarios(options.holdoutDir ?? HOLDOUT_DIR), { ...shared, network: new ReportStore() });
  return { run, holdout, meta: { agent: "scripted", aiSource: aiSource(aiRecorded) }, network: shared.network };
}

export async function runAndWriteOffline(): Promise<OfflineRun> {
  const result = await runOffline({ auditPath: `${RESULTS_DIR}/audit.jsonl` });
  writeResults(result.run, result.meta, result.holdout, "latest");
  writeFileSync(SEED_FEED_FILE, serializeFeed(result.network.lines()));
  return result;
}
