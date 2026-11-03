// Writes results as Markdown and JSON, from a run. Every number comes from the run itself.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { newestHoldoutLine } from "./offline.js";
import { assetLabel, formatAmounts, type LabRun, type Payment, type ScenarioResult, summaryLine } from "./lab.js";

export const RESULTS_DIR = fileURLToPath(new URL("../results/", import.meta.url));

export interface ResultsMeta {
  /** How the agent decided. */
  agent: "scripted" | "llm";
  /** A plain statement of where AI answers came from. */
  aiSource: string;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function describePayments(payments: Payment[]): string {
  if (payments.length === 0) return "pays nothing";
  const groups = new Map<string, { count: number; amount: string; asset: string; payee: string }>();
  for (const { payee, asset, amount } of payments) {
    const key = `${payee}|${asset}|${amount}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { count: 1, amount, asset, payee });
  }
  return [...groups.values()]
    .map(({ count, amount, asset, payee }) => {
      const shown = payee.length > 26 ? `${payee.slice(0, 8)}…${payee.slice(-6)}` : payee;
      return `pays ${amount} ${assetLabel(asset)} to \`${shown}\`${count > 1 ? ` ${count} times` : ""}`;
    })
    .join(", ");
}

function describeWith(scenario: ScenarioResult): string {
  return scenario.with.steps
    .map((step) => {
      const owner = step.ownerDecision ? `, owner ${step.ownerDecision === "reject" ? "rejects" : "approves"}` : "";
      const codes = step.codes.filter((code) => code !== "AI_UNAVAILABLE").join(", ");
      return `${step.decision} (${codes || "no signals"})${owner}`;
    })
    .join("<br>");
}

function tableOf(scenarios: ScenarioResult[]): string[] {
  const lines = [
    "| # | Scenario | Setup | Without Wardy Agent | Lost | With Wardy Agent | Lost | Verdicts |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const scenario of scenarios) {
    const verdicts = scenario.with.steps.map((step) => `\`${step.verdictId.slice(0, 8)}\``).join(" ");
    lines.push(
      `| ${scenario.id} | ${cell(scenario.title)} | ${cell(scenario.setup)} | ${describePayments(scenario.without.payments)} | ${formatAmounts(scenario.without.lost)} | ${cell(describeWith(scenario))} | ${formatAmounts(scenario.with.lost)} | ${verdicts} |`,
    );
  }
  return lines;
}

export function toMarkdown(run: LabRun, meta: ResultsMeta, holdout?: LabRun): string {
  const agentLine =
    meta.agent === "scripted"
      ? "**Agent:** a script that does whatever it reads, every time. It's a deterministic worst case, not a measurement of any real model, so the \"without\" column shows what's at stake, not how often a real agent falls for it."
      : "**Agent:** a real model deciding for itself, with a short and trusting prompt.";
  const lines = [
    "# Attack Lab results",
    "",
    summaryLine(run.totals).replace(/ · /g, ". ") + ".",
    "",
    agentLine,
    "",
    `**Private AI:** ${meta.aiSource}`,
    "",
    "**Money:** nothing here touches a real network. \"Without\" pays into a plain list. \"With\" goes through the real HTTP API, into a mock custody ledger. Losses are worked out from what actually moved on each ledger, against what was really owed.",
    "",
    "**Check it yourself:** every verdict is signed and in [`audit.jsonl`](audit.jsonl). Run `npm run verify-audit -- apps/attack-lab/results/audit.jsonl`.",
    "",
    "## Scenarios",
    "",
    ...tableOf(run.scenarios),
    "",
  ];
  if (holdout && holdout.scenarios.length > 0) {
    const missed = holdout.scenarios.filter((scenario) => scenario.kind === "attack" && Object.keys(scenario.with.lost).length > 0);
    lines.push(
      "## Holdout: written after the rules were frozen",
      "",
      "The scenarios above were written alongside the rules, so they show the rules work as designed, not that they stop what they haven't seen. These were written after a freeze, and nothing was changed after seeing the results of the set in force. B and HB came first. The unusual amount check was added after their results were seen, so C and HC were written next, aimed at getting around it. A change for HB5 was then made after those results were seen, so D and HD came next. Three more rules were added after seeing all of those, so E and HE were written after that, aimed at getting around them. Only E and HE are blind to today's rules. Same author, so it's weak evidence, but any misses are shown as they happened.",
      "",
      summaryLine(holdout.totals).replace(/ · /g, ". ") + ".",
      "",
      `Attacks where money still moved: ${missed.length} of ${holdout.scenarios.filter((scenario) => scenario.kind === "attack").length}.${missed.length > 0 ? ` (${missed.map((scenario) => scenario.id).join(", ")})` : ""}`,
      "",
      `**${newestHoldoutLine(holdout)}**`,
      "",
      `False blocks on honest payments, counting one that's only held for the owner: ${holdout.totals.falseBlocks}. Refused outright: ${holdout.scenarios.filter((scenario) => scenario.kind === "honest").flatMap((scenario) => scenario.with.steps).filter((step) => step.decision === "BLOCK").length}.`,
      "",
      ...tableOf(holdout.scenarios),
      "",
    );
  }
  return `${lines.join("\n")}`;
}

export function toJson(run: LabRun, meta: ResultsMeta, holdout?: LabRun): string {
  return `${JSON.stringify({ ...meta, ...run, ...(holdout ? { holdout } : {}) }, null, 2)}\n`;
}

export function writeResults(run: LabRun, meta: ResultsMeta, holdout: LabRun | undefined, name: string, dir: string = RESULTS_DIR): void {
  mkdirSync(dirname(`${dir}/x`), { recursive: true });
  writeFileSync(`${dir}/${name}.md`, toMarkdown(run, meta, holdout));
  writeFileSync(`${dir}/${name}.json`, toJson(run, meta, holdout));
}
