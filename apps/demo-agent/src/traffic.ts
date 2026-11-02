// A short run of real payment requests for the dashboard, so a visitor can see it work with no agent attached. It's the
// same scripted agent as the Attack Lab, asking the real API. Nothing here decides anything.
import { type PayArgs, runScriptedAgent } from "./agent.js";
import { loadScenarios, type Scenario } from "./scenario.js";

const IMITATOR = "g1obex-supply.near";

type Beat = { scenario: string } | { anotherAgentAsks: PayArgs };

/**
 * One story, in order. An honest payment passes, and a fake "payment failed" is held for the owner. A lookalike is
 * blocked, which publishes a report. Later, another owner's agent asks about that same name, and the report stops it.
 * The lookalike's name isn't in the seeded feed, so the report really is made here, and the reason shown is the real one.
 */
const STORY: Beat[] = [
  { scenario: "honest-usdc" },
  { scenario: "retry" },
  { scenario: "rebrand" },
  { scenario: "honest-threshold" },
  { scenario: "cross-chain" },
  { anotherAgentAsks: { payee: IMITATOR, asset: "USDC", amount: "1.5", purpose: "Pay the Globex rebrand invoice" } },
  { scenario: "honest-api-call" },
  { scenario: "inflated-invoice" },
];

export interface TrafficOptions {
  /** How long to wait between payments, so a person can follow along. */
  paceMs?: number;
  scenarios?: Scenario[];
  /** How many times this has played. A new invoice each time, so it isn't a real duplicate of the one before. */
  play?: number;
}

/** The same story with a new invoice: a new number, its own text, and slightly less, so it stays under every limit. */
function forPlay(args: PayArgs, play: number): PayArgs {
  if (play === 0) return args;
  const { context } = args;
  return {
    ...args,
    amount: String(Number((Number(args.amount) * (1 - play * 0.001)).toFixed(6))),
    ...(args.invoiceId ? { invoiceId: `${args.invoiceId}-${play}` } : {}),
    ...(context?.invoiceText ? { context: { ...context, invoiceText: `${context.invoiceText}\nRef ${play}` } } : {}),
  };
}

export async function playTraffic(ask: (who: "fleet" | "other", args: PayArgs) => Promise<void>, options: TrafficOptions = {}): Promise<void> {
  const all = options.scenarios ?? loadScenarios();
  const paceMs = options.paceMs ?? 1600;
  const play = options.play ?? 0;
  const pause = () => new Promise((resolve) => setTimeout(resolve, paceMs));
  for (const beat of STORY) {
    if ("anotherAgentAsks" in beat) {
      await ask("other", forPlay(beat.anotherAgentAsks, play));
      await pause();
      continue;
    }
    const scenario = all.find((candidate) => candidate.slug === beat.scenario);
    if (!scenario) throw new Error(`The demo traffic needs the scenario "${beat.scenario}".`);
    await runScriptedAgent(scenario, async (args) => {
      await ask("fleet", forPlay(args, play));
      await pause();
      return { text: "" };
    });
  }
}
