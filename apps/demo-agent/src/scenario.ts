// A scenario is a folder: what lands in the agent's inbox, in plain text, plus scenario.json. Same format for the
// demo agent, the Attack Lab and the holdout set.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const ExpectSchema = z.strictObject({
  decision: z.enum(["ALLOW", "HOLD", "BLOCK"]),
  codes: z.array(z.string()),
  /** Signals only the private AI can raise, checked only when real recorded answers exist. */
  aiCodes: z.array(z.string()).optional(),
});

const StepSchema = z.strictObject({
  payee: z.string(),
  chain: z.string().optional(),
  asset: z.string(),
  amount: z.string(),
  invoiceId: z.string().optional(),
  purpose: z.string(),
  /** Which files the agent had read by this point. */
  reads: z.array(z.string()),
  /** Time that passes before this step: a patient attacker doesn't retry inside the duplicate window. */
  waitMinutes: z.number().positive().optional(),
  /** Left out of the holdout set: it's measured, not expected. */
  expect: ExpectSchema.optional(),
});

const ScenarioSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  kind: z.enum(["attack", "honest"]),
  setup: z.string(),
  /** "other" is another owner's agent: it can ask Wardy Agent, but Wardy Agent doesn't spend for it. */
  owner: z.enum(["fleet", "other"]).optional(),
  inbox: z.array(z.strictObject({ file: z.string(), kind: z.enum(["invoice", "email"]) })),
  /** What the first successful payment's tool result is replaced with: an attacker controlling that tool's output. */
  fakeToolResult: z.string().optional(),
  /** What's really owed. Anything paid beyond this is money lost. */
  owed: z.array(z.strictObject({ payee: z.string(), asset: z.string(), amount: z.string() })),
  /** What the owner says if a step of this scenario is held. */
  ownerDecision: z.enum(["approve", "reject"]).optional(),
  reportExpected: z.boolean().optional(),
  steps: z.array(StepSchema).min(1),
});

export type ScenarioMeta = z.output<typeof ScenarioSchema>;
export type ScenarioStep = z.output<typeof StepSchema>;

export interface Scenario extends ScenarioMeta {
  slug: string;
  /** File name to contents. Untrusted text: data only. */
  files: Record<string, string>;
}

export const SCENARIOS_DIR = fileURLToPath(new URL("../scenarios/", import.meta.url));

export function loadScenario(folder: string): Scenario {
  const meta = ScenarioSchema.parse(JSON.parse(readFileSync(join(folder, "scenario.json"), "utf8")));
  const names = new Set([...meta.inbox.map((item) => item.file), ...meta.steps.flatMap((step) => step.reads), ...(meta.fakeToolResult ? [meta.fakeToolResult] : [])]);
  const files: Record<string, string> = {};
  for (const name of names) files[name] = readFileSync(join(folder, name), "utf8");
  return { ...meta, slug: folder.split(/[\\/]/).filter(Boolean).at(-1) as string, files };
}

/** Every scenario in a folder, in the order a report reads naturally: A1, A2... then H1, H2... */
export function loadScenarios(root: string = SCENARIOS_DIR): Scenario[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "scenario.json")))
    .map((entry) => loadScenario(join(root, entry.name)))
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
}

/** Files by what they are, for the `context` of a payment request. */
export function contextFrom(scenario: Scenario, names: readonly string[]) {
  const pick = (test: (name: string) => boolean) =>
    names
      .filter(test)
      .map((name) => scenario.files[name])
      .join("\n\n") || undefined;
  const kindOf = (name: string) => scenario.inbox.find((item) => item.file === name)?.kind;
  const invoiceText = pick((name) => kindOf(name) === "invoice");
  const emailText = pick((name) => kindOf(name) === "email");
  const toolResultText = pick((name) => name === scenario.fakeToolResult);
  const context = {
    ...(invoiceText ? { invoiceText } : {}),
    ...(emailText ? { emailText } : {}),
    ...(toolResultText ? { toolResultText } : {}),
  };
  return Object.keys(context).length > 0 ? context : undefined;
}
