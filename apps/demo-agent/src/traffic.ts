// A short run of real payment requests for the dashboard, so a visitor can see it work with no agent attached. It's the
// same scripted agent as the Attack Lab, asking the real API. Nothing here decides anything.
import { type PayArgs, runScriptedAgent } from "./agent.js";
import { loadScenarios, type Scenario } from "./scenario.js";

/**
 * One story, in order. An honest payment passes, a fake "payment failed" gets held for the owner, a lookalike is blocked,
 * another honest one passes, a subtler lookalike is blocked, and then another owner's agent is protected by the network.
 */
const PLAYLIST = ["honest-usdc", "retry", "lookalike", "honest-threshold", "suffix-trick", "network-protected", "honest-api-call", "prompt-injection"];

export interface TrafficOptions {
  /** How long to wait between payments, so a person can follow along. */
  paceMs?: number;
  scenarios?: Scenario[];
}

export async function playTraffic(ask: (scenario: Scenario, args: PayArgs) => Promise<void>, options: TrafficOptions = {}): Promise<void> {
  const all = options.scenarios ?? loadScenarios();
  const paceMs = options.paceMs ?? 1600;
  for (const slug of PLAYLIST) {
    const scenario = all.find((candidate) => candidate.slug === slug);
    if (!scenario) throw new Error(`The demo traffic needs the scenario "${slug}".`);
    await runScriptedAgent(scenario, async (args) => {
      await ask(scenario, args);
      await new Promise((resolve) => setTimeout(resolve, paceMs));
      return { text: "" };
    });
  }
}
