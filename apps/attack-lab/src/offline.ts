// The offline run: scripted agent, recorded AI answers if there are any, one audit chain. Same bytes every time.
import { rmSync, writeFileSync } from "node:fs";
import { type AnchorRecord, AuditLog, feedLineLeaf, ReportStore, serializeFeed, type VerdictView } from "@wardy-agent/core";
import { loadScenarios } from "@wardy-agent/demo-agent";
import { MockContextAnalyzer, RECORDED_AI_FINDINGS } from "@wardy-agent/providers";
import { fileURLToPath } from "node:url";
import { formatAmounts, type LabRun, runLab, type ScenarioResult, summaryLine } from "./lab.js";
import { RESULTS_DIR, type ResultsMeta, writeResults } from "./results.js";

export const HOLDOUT_DIR = fileURLToPath(new URL("../holdout/", import.meta.url));
/** The reports the main set produced, labelled as seed. Same bytes every time, so anyone can rebuild what was anchored. */
const SEED_FEED_NAME = "network-seed.jsonl";
export const SEED_FEED_FILE = `${RESULTS_DIR}${SEED_FEED_NAME}`;

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

/** The set written after the latest rule freeze. Older sets have been seen and used to tune, so only this one wasn't. */
export const isNewestHoldout = (id: string) => /^H?E\d/.test(id);

/** How the newest set went on its own, so the older sets can't hide it. */
export function newestHoldoutLine(holdout: LabRun): string {
  const newest = holdout.scenarios.filter((scenario) => isNewestHoldout(scenario.id));
  const attacks = newest.filter((scenario) => scenario.kind === "attack");
  const missed = attacks.filter((scenario) => Object.keys(scenario.with.lost).length > 0);
  const honest = newest.filter((scenario) => scenario.kind === "honest");
  const passed = honest.filter((scenario) => scenario.with.steps.every((step) => step.decision === "ALLOW"));
  return `Only the newest set was never used to tune the rules: ${missed.length} of ${attacks.length} attacks took money, and ${passed.length} of ${honest.length} honest payments passed.`;
}

/** A plain statement of how the holdout went, computed from the run. */
export function holdoutLine(holdout: LabRun): string {
  const attacks = holdout.scenarios.filter((scenario) => scenario.kind === "attack");
  const missed = attacks.filter((scenario) => Object.keys(scenario.with.lost).length > 0);
  const honest = holdout.scenarios.length - attacks.length;
  return `Holdout, written after the rules froze: ${missed.length} of ${attacks.length} attacks still took money (${formatAmounts(holdout.totals.lostWith)}). Honest messages passed: ${holdout.totals.honestPassed}/${honest}. ${newestHoldoutLine(holdout)}`;
}

/** What to say about this run's reports. It only claims an anchor for reports the anchor really covers. */
export function networkLines(network: ReportStore, anchor: AnchorRecord | null): string[] {
  const leaves = network.lines().map(feedLineLeaf);
  const anchored = anchor !== null && leaves.length > 0 && leaves.every((leaf) => anchor.leaves.includes(leaf));
  return [
    `Wardy Network: this run produced ${network.all().length} signed reports, labelled as seed.`,
    ...(anchored ? [`Their root is anchored on NEAR testnet: ${anchor.txUrl}`, "Check it yourself: npm run network:verify"] : ["They aren't anchored yet: the Attack Lab's output changed since the last anchor."]),
  ];
}

/** Writes nothing unless `auditPath` is given. */
export async function runOffline(
  options: {
    auditPath?: string;
    holdoutDir?: string;
    onScenario?: (set: "main" | "holdout", result: ScenarioResult) => void;
    onVerdict?: (verdict: VerdictView) => void;
  } = {},
): Promise<OfflineRun> {
  if (options.auditPath) rmSync(options.auditPath, { force: true });
  const audit = new AuditLog(options.auditPath);
  const aiRecorded = Object.keys(RECORDED_AI_FINDINGS).length > 0;
  const shared = {
    agent: "scripted" as const,
    aiRecorded,
    analyzer: new MockContextAnalyzer(RECORDED_AI_FINDINGS),
    audit,
    network: new ReportStore(),
    ...(options.onVerdict ? { onVerdict: options.onVerdict } : {}),
  };
  const run = await runLab(loadScenarios(), { ...shared, onScenario: (result) => options.onScenario?.("main", result) });
  // Its own network: a holdout attack shouldn't get help from reports the main set produced.
  const holdout = await runLab(loadScenarios(options.holdoutDir ?? HOLDOUT_DIR), { ...shared, network: new ReportStore(), onScenario: (result) => options.onScenario?.("holdout", result) });
  return { run, holdout, meta: { agent: "scripted", aiSource: aiSource(aiRecorded) }, network: shared.network };
}

export interface LabStreamDone {
  summary: string;
  holdout: string;
  aiSource: string;
  totals: LabRun["totals"];
  holdoutTotals: LabRun["totals"];
  lostWithoutText: string;
  lostWithText: string;
}

/** The same run as `npm run attack-lab -- --offline`, told as it happens. Writes nothing. */
export async function streamOffline(
  send: (event: string, data: unknown) => void,
  onVerdict?: (verdict: VerdictView) => void,
): Promise<void> {
  const total = loadScenarios().length + loadScenarios(HOLDOUT_DIR).length;
  send("start", { total });
  let index = 0;
  const { run, holdout, meta } = await runOffline({
    onScenario: (set, result) => {
      index += 1;
      send("scenario", { set, index, total, result });
    },
    ...(onVerdict ? { onVerdict } : {}),
  });
  const done: LabStreamDone = {
    summary: summaryLine(run.totals),
    holdout: holdoutLine(holdout),
    aiSource: meta.aiSource,
    totals: run.totals,
    holdoutTotals: holdout.totals,
    lostWithoutText: formatAmounts(run.totals.lostWithout),
    lostWithText: formatAmounts(run.totals.lostWith),
  };
  send("done", done);
}

export async function runAndWriteOffline(dir: string = RESULTS_DIR): Promise<OfflineRun> {
  const result = await runOffline({ auditPath: `${dir}/audit.jsonl` });
  writeResults(result.run, result.meta, result.holdout, "latest", dir);
  writeFileSync(`${dir}/${SEED_FEED_NAME}`, serializeFeed(result.network.lines()));
  return result;
}
