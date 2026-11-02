// The dashboard's demo buttons, through the real API, the way they run for a visitor.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEED_FEED_FILE } from "@wardy-agent/attack-lab";
import { buildApp, type DemoTools, wire } from "@wardy-agent/api";
import { parseFeed, verifyReportEvidence, type VerdictView } from "@wardy-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { demoTools } from "../demo-tools.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setUp() {
  const dataDir = mkdtempSync(join(tmpdir(), "wardy-agent-demo-tools-"));
  dirs.push(dataDir);
  const wiring = await wire({ WARDY_MODE: "offline" }, { dataDir });
  wiring.reports.merge(parseFeed(readFileSync(SEED_FEED_FILE, "utf8")));
  const tools = demoTools(wiring, (request) => app.inject(request), { paceMs: 0 }) as DemoTools;
  const app = await buildApp({ service: wiring.service, network: wiring.network, reporting: wiring.reporting, agentToken: wiring.agentToken, ownerToken: wiring.ownerToken, mode: wiring.mode, demo: tools });
  return { wiring, tools, app };
}

describe("where the demo tools exist", () => {
  it.each(["testnet", "live"] as const)("not in %s mode: nothing should send made-up payments where real ones are possible", (mode) => {
    expect(demoTools({ mode, agentToken: "x", service: {} as never }, async () => undefined)).toBeUndefined();
  });
});

describe("demo traffic", () => {
  it("tells the whole story with real verdicts: one attack creates a report, and that report protects another owner's agent", async () => {
    const { wiring, tools, app } = await setUp();
    await tools.playTraffic();
    const verdicts = [...wiring.service.recentVerdicts(100)].reverse() as VerdictView[];
    expect(verdicts.map((verdict) => verdict.decision)).toEqual(["ALLOW", "ALLOW", "HOLD", "BLOCK", "ALLOW", "BLOCK", "BLOCK", "ALLOW", "BLOCK"]);

    const attack = verdicts.find((verdict) => verdict.payee === "g1obex-supply.near" && verdict.mode === "pay") as VerdictView;
    // Its reason is what the owner should read: the lookalike, not a note about the network.
    expect(attack.reasons[0]).toContain("globex-supply.near");
    expect(attack.networkReportId).toBeDefined();

    const report = wiring.reports.all().find((candidate) => candidate.reportId === attack.networkReportId);
    expect(report?.seed).toBeUndefined();
    expect(await verifyReportEvidence(report as NonNullable<typeof report>)).toBe(true);

    const protectedCheck = verdicts.find((verdict) => verdict.payee === "g1obex-supply.near" && verdict.mode === "check") as VerdictView;
    expect(protectedCheck.signals.find((signal) => signal.code === "NETWORK_REPORTED_SCAM")?.evidence.reportId).toBe(attack.networkReportId);

    // The hold waits for the owner, and nothing here decided it.
    expect(wiring.service.pendingHolds()).toHaveLength(1);
    await app.close();
  });

  it("pressing it again tells the same story, instead of piling up fake duplicates", async () => {
    const { wiring, tools, app } = await setUp();
    await tools.playTraffic();
    const first = wiring.service.recentVerdicts(100).length;
    await tools.playTraffic();
    const again = wiring.service.recentVerdicts(100).slice(0, wiring.service.recentVerdicts(100).length - first).reverse();
    const honest = again.filter((verdict) => ["globex-supply.near", "initech-cloud.near", "umbrella-data-api.near"].includes(verdict.payee));
    expect(honest.map((verdict) => verdict.decision)).toEqual(["ALLOW", "ALLOW", "ALLOW"]);
    // The story's own repeat is still caught.
    expect(again.filter((verdict) => verdict.payee === "acme-shop.near").map((verdict) => verdict.decision).slice(0, 2)).toEqual(["ALLOW", "HOLD"]);
    await app.close();
  });

  it("moves money only on the mock ledger", async () => {
    const { wiring, tools, app } = await setUp();
    await tools.playTraffic();
    expect(wiring.custody.name).toBe("mock");
    await app.close();
  });
});

describe("the lab from the dashboard", () => {
  it("keeps each run's verdicts so a row's link opens, and clears them on the next run", async () => {
    const { tools, app } = await setUp();
    const ids: string[] = [];
    await tools.runLab((event, data) => {
      if (event === "scenario") for (const step of (data as { result: { with: { steps: { verdictId: string }[] } } }).result.with.steps) ids.push(step.verdictId);
    });
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect(tools.labVerdict(id)?.verdictId, id).toBe(id);
    const opened = await app.inject({ method: "GET", url: `/v1/verdicts/${ids[0]}`, headers: { authorization: "Bearer offline-owner-token" } });
    expect(opened.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/v1/verdicts/${ids[0]}/verify` })).json().valid).toBe(true);
    await app.close();
  });
});
