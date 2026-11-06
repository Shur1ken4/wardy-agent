// What the dashboard's demo buttons run, in offline mode only. They use the real API and the Attack Lab's mock ledgers,
// so nothing here can reach a network or move money.
import { HOLDOUT_DIR, streamOffline } from "@wardy-agent/attack-lab";
import type { DemoTools, Wiring } from "@wardy-agent/api";
import type { VerdictView } from "@wardy-agent/core";
import { loadScenarios, playTraffic } from "@wardy-agent/demo-agent";

const OTHER_OWNER = "other-owner.near";

type Inject = (request: { method: "POST"; url: string; headers: Record<string, string>; payload: Record<string, unknown> }) => Promise<unknown>;

/** Only offline: nothing that sends made-up payments should exist where real ones are possible. */
export function demoTools(wiring: Pick<Wiring, "mode" | "agentToken" | "service">, inject: Inject, options: { paceMs?: number } = {}): DemoTools | undefined {
  if (wiring.mode !== "offline") return undefined;
  const labVerdicts = new Map<string, VerdictView>();
  let plays = 0;
  return {
    playTraffic: () =>
      playTraffic(
        async (who, args) => {
          const other = who === "other";
          await inject({
            method: "POST",
            url: other ? "/v1/check" : "/v1/pay",
            // The other owner's check carries this credential too, only so a hosted server sends it to this visitor's
            // sandbox, whose Network has the report. It asks as another owner, so it reads none of this owner's history.
            headers: { authorization: `Bearer ${wiring.agentToken}` },
            payload: {
              requestId: crypto.randomUUID(),
              agentId: other ? "agent-b" : "procure-bot",
              ownerId: other ? OTHER_OWNER : wiring.service.fleetOwnerId,
              chain: "near",
              createdAt: new Date().toISOString(),
              ...args,
              purpose: args.purpose || "not stated",
            },
          });
        },
        { scenarios: [...loadScenarios(), ...loadScenarios(HOLDOUT_DIR)], play: plays++, ...(options.paceMs === undefined ? {} : { paceMs: options.paceMs }) },
      ),
    runLab: (send) => {
      labVerdicts.clear();
      return streamOffline(send, (verdict) => labVerdicts.set(verdict.verdictId, verdict));
    },
    labVerdict: (verdictId) => labVerdicts.get(verdictId),
  };
}
