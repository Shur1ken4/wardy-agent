// `npm run readme:results`: writes the Attack Lab table into the README from the committed results, so no number in the
// README is typed by hand. A test fails if the README and the results ever disagree.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const README = fileURLToPath(new URL("../README.md", import.meta.url));
const RESULTS = fileURLToPath(new URL("../apps/attack-lab/results/latest.json", import.meta.url));
const START = "<!-- results:start -->";
const END = "<!-- results:end -->";
const ASSETS: Record<string, string> = {
  "nep141:wrap.near": "NEAR",
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": "USDC",
};

interface Row {
  id: string;
  title: string;
  without: { lost: Record<string, string> };
  with: { lost: Record<string, string>; steps: { decision: string }[] };
}

interface Totals {
  lostWithout: Record<string, string>;
  lostWith: Record<string, string>;
  honestPassed: number;
  honestTotal: number;
  falseBlocks: number;
}

interface Results {
  scenarios: Row[];
  totals: Totals;
  holdout: { scenarios: Row[]; totals: Totals };
}

function money(lost: Record<string, string>): string {
  const entries = Object.entries(lost);
  return entries.length === 0 ? "0" : entries.map(([asset, amount]) => `${amount} ${ASSETS[asset] ?? asset}`).join(" + ");
}

function table(rows: Row[]): string[] {
  return [
    "| # | Scenario | Lost without | With Wardy Agent | Lost with |",
    "|---|---|---|---|---|",
    ...rows.map((row) => {
      const lostWith = money(row.with.lost);
      return `| ${row.id} | ${row.title.replaceAll("|", "\\|")} | ${money(row.without.lost)} | ${row.with.steps.map((step) => step.decision).join(", ")} | ${lostWith === "0" ? "0" : `**${lostWith}**`} |`;
    }),
  ];
}

export function resultsBlock(): string {
  const results = JSON.parse(readFileSync(RESULTS, "utf8")) as Results;
  const { totals, holdout } = results;
  const attacks = holdout.scenarios.filter((row) => !row.id.startsWith("HB"));
  const missed = attacks.filter((row) => Object.keys(row.with.lost).length > 0);
  return [
    START,
    `**Main set (written alongside the rules):** lost without Wardy Agent: ${money(totals.lostWithout)}. Lost with it: ${money(totals.lostWith)}. Honest payments passed: ${totals.honestPassed}/${totals.honestTotal}. False blocks: ${totals.falseBlocks}.`,
    "",
    ...table(results.scenarios),
    "",
    `**Holdout (written after the rules were frozen, and never tuned for):** ${missed.length} of ${attacks.length} attacks still took money (${money(holdout.totals.lostWith)}). Honest messages passed: ${holdout.totals.honestPassed}/${holdout.totals.honestTotal}.`,
    "",
    ...table(holdout.scenarios),
    END,
  ].join("\n");
}

export function withResults(readme: string): string {
  const from = readme.indexOf(START);
  const to = readme.indexOf(END);
  if (from < 0 || to < 0) throw new Error(`The README needs ${START} and ${END}.`);
  return `${readme.slice(0, from)}${resultsBlock()}${readme.slice(to + END.length)}`;
}

if (process.argv[1]?.endsWith("readme-results.ts")) {
  writeFileSync(README, withResults(readFileSync(README, "utf8")));
  console.log("The README's Attack Lab table now matches the committed results.");
}
