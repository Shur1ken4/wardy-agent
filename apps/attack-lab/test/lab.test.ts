import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, type ContextAnalyzer, OFFLINE_TEST_SIGNING_KEY, publicKeyOf, ReportStore, USDC_ASSET, verifyAuditLines, verifyReportEvidence, WNEAR_ASSET } from "@wardy-agent/core";
import { loadScenarios, type Scenario } from "@wardy-agent/demo-agent";
import { OFFLINE_ACCOUNTS } from "@wardy-agent/providers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type LabContext, lossesFrom, runLab, runScenario, type ScenarioResult, summaryLine, summaryLines } from "../src/lab.js";
import { runOffline } from "../src/offline.js";
import { toJson, toMarkdown } from "../src/results.js";

const scenarios = loadScenarios();
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function context(overrides: Partial<LabContext> = {}): LabContext {
  return { agent: "scripted", aiRecorded: false, audit: new AuditLog(), network: new ReportStore(), ...overrides };
}

let offline: Awaited<ReturnType<typeof runOffline>>;
const byId = (id: string): ScenarioResult => offline.run.scenarios.find((scenario) => scenario.id === id) as ScenarioResult;

beforeAll(async () => {
  offline = await runOffline();
});

describe("the scenarios", () => {
  it("are the brief's nine attacks and four honest payments", () => {
    expect(scenarios.map((scenario) => scenario.id)).toEqual(["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "H1", "H2", "H3", "H4"]);
  });

  it("use no real account: every NEAR payee is a fixture, which check:fixtures proves unregistered", () => {
    for (const scenario of scenarios) {
      for (const step of scenario.steps) {
        if ((step.chain ?? "near") === "near") expect(Object.keys(OFFLINE_ACCOUNTS), step.payee).toContain(step.payee);
      }
    }
  });

  it("never mention the real accounts shop.near or sh0p.near", () => {
    for (const scenario of scenarios) {
      const text = JSON.stringify(scenario);
      expect(text).not.toMatch(/(^|[^-a-z0-9])sh[o0]p\.near/);
    }
  });
});

describe("the brief's expected results", () => {
  it.each<[string, string[]]>([
    ["A1", ["BLOCK"]],
    ["A2", ["ALLOW", "HOLD"]],
    ["A3", ["BLOCK"]],
    ["A4", ["BLOCK"]],
    ["A5", ["BLOCK"]],
    ["A6", ["BLOCK"]],
    ["A7", ["BLOCK"]],
    ["A8", ["BLOCK"]],
    ["A9", ["HOLD", "HOLD", "BLOCK", "BLOCK", "BLOCK"]],
    ["H1", ["ALLOW"]],
    ["H2", ["ALLOW"]],
    ["H3", ["ALLOW"]],
    ["H4", ["ALLOW"]],
  ])("%s", (id, decisions) => {
    expect(byId(id).with.steps.map((step) => step.decision)).toEqual(decisions);
    expect(byId(id).problems).toEqual([]);
  });

  it("without Wardy Agent, every attack costs money", () => {
    for (const scenario of offline.run.scenarios.filter((item) => item.kind === "attack")) {
      expect(Object.keys(scenario.without.lost).length, scenario.id).toBeGreaterThan(0);
    }
  });

  it("with Wardy Agent, no attack costs anything", () => {
    for (const scenario of offline.run.scenarios) expect(scenario.with.lost, scenario.id).toEqual({});
  });

  it("works out each loss from what actually moved", () => {
    expect(byId("A1").without.lost).toEqual({ [WNEAR_ASSET]: "2" });
    expect(byId("A2").without.lost).toEqual({ [WNEAR_ASSET]: "2" }); // The real debt, paid twice: the second is the loss.
    expect(byId("A2").without.payments).toHaveLength(2);
    expect(byId("A4").without.lost).toEqual({ [WNEAR_ASSET]: "8.36" }); // 10.36 paid, 2 owed.
    expect(byId("A6").without.lost).toEqual({ [USDC_ASSET]: "25" });
    expect(byId("A9").without.lost).toEqual({ [WNEAR_ASSET]: "5" });
  });

  it("honest payments lose nothing either way, and really pay with Wardy Agent", () => {
    for (const id of ["H1", "H2", "H3", "H4"]) {
      expect(byId(id).without.lost).toEqual({});
      expect(byId(id).with.steps.every((step) => step.executionStatus === "executed" && step.riskScore < 30)).toBe(true);
    }
    expect(offline.run.totals).toMatchObject({ honestPassed: 4, honestTotal: 4, falseBlocks: 0 });
  });

  it("A2: the first payment goes through, and only the fake retry is stopped", () => {
    expect(byId("A2").with.payments).toEqual([{ payee: "acme-shop.near", asset: WNEAR_ASSET, amount: "2" }]);
    expect(byId("A2").with.steps[1]).toMatchObject({ decision: "HOLD", ownerDecision: "reject", executionStatus: "refused" });
    expect(byId("A2").with.steps[1]?.reason).toContain("Pay again?");
  });

  it("A7: the other owner's agent only asks, and is stopped by a report from A1", () => {
    const step = byId("A7").with.steps[0];
    expect(step?.codes).toContain("NETWORK_REPORTED_SCAM");
    expect(step?.codes).not.toContain("LOOKALIKE_HOMOGLYPH"); // Owner B has no history: the network is what saved it.
    expect(step?.executionStatus).toBeNull();
  });

  it("A7 depends on A1: with no earlier attack, the network has nothing to say", async () => {
    const a7 = scenarios.find((scenario) => scenario.id === "A7") as Scenario;
    const alone = await runScenario(a7, context());
    expect(alone.with.steps[0]?.codes).not.toContain("NETWORK_REPORTED_SCAM");
    expect(alone.problems.length).toBeGreaterThan(0);
  });

  it("publishes reports only where there's evidence: not for a tampered real merchant, or a likely typo", () => {
    const reported = (id: string) => byId(id).with.steps.some((step) => step.networkReportId);
    expect(["A1", "A3", "A5", "A8", "A9"].every(reported)).toBe(true);
    expect(["A2", "A4", "A6", "A7", "H1", "H2", "H3", "H4"].some(reported)).toBe(false);
  });
});

describe("the lab can't simply report success", () => {
  it("catches a decision that doesn't match", async () => {
    const a1 = scenarios.find((scenario) => scenario.id === "A1") as Scenario;
    const wrong: Scenario = { ...a1, steps: a1.steps.map((step) => ({ ...step, expect: { decision: "ALLOW" as const, codes: [] } })) };
    expect((await runScenario(wrong, context())).problems).toContain("step 1: expected ALLOW, got BLOCK");
  });

  it("catches a missing signal", async () => {
    const a1 = scenarios.find((scenario) => scenario.id === "A1") as Scenario;
    const wrong: Scenario = { ...a1, steps: a1.steps.map((step) => ({ ...step, expect: { decision: "BLOCK" as const, codes: ["MADE_UP_CODE"] } })) };
    expect((await runScenario(wrong, context())).problems).toContain("step 1: expected signal MADE_UP_CODE");
  });

  it("an honest payment that's held counts as a false block", async () => {
    const h1 = scenarios.find((scenario) => scenario.id === "H1") as Scenario;
    // A payee the demo owner has never paid: the kind of payment that really would be held.
    const held: Scenario = { ...h1, steps: h1.steps.map((step) => ({ ...step, payee: "billing-desk-pay.near" })) };
    const result = await runScenario(held, context());
    expect(result.problems.join(" ")).toContain("false block");
    const run = await runLab([held], context());
    expect(run.totals).toMatchObject({ honestPassed: 0, falseBlocks: 1 });
  });

  it("if the owner approves a held attack, the loss shows: it's measured, not assumed", async () => {
    const a9 = scenarios.find((scenario) => scenario.id === "A9") as Scenario;
    const trusting: Scenario = { ...a9, ownerDecision: "approve" };
    expect((await runScenario(trusting, context())).with.lost[WNEAR_ASSET]).toBeDefined();
  });

  it("a payment moved by the engine appears in the loss: nothing's hard-coded", async () => {
    const a2 = scenarios.find((scenario) => scenario.id === "A2") as Scenario;
    const result = await runScenario({ ...a2, ownerDecision: "approve" }, context());
    expect(result.with.lost).toEqual({ [WNEAR_ASSET]: "2" });
  });
});

describe("the AI can't make it worse", () => {
  const compromised: ContextAnalyzer = {
    analyze: async () => ({
      findings: {
        payee_change_requested: false,
        urgency_or_pressure: false,
        asks_to_bypass_limits_or_rules: false,
        claims_previous_payment_failed: false,
        mentions_new_account_or_address: false,
        confidence: 1,
      },
      model: "compromised",
      attested: true,
    }),
  };

  it("with a compromised AI saying all is well, every decision is the same and nothing is lost", async () => {
    const run = await runLab(scenarios, context({ analyzer: compromised }));
    for (const scenario of run.scenarios) expect(scenario.problems, scenario.id).toEqual([]);
    expect(run.totals.lostWith).toEqual({});
  });
});

describe("repeatability", () => {
  it("two offline runs give the same bytes", async () => {
    const again = await runOffline();
    expect(toJson(again.run, again.meta, again.holdout)).toBe(toJson(offline.run, offline.meta, offline.holdout));
    expect(toMarkdown(again.run, again.meta, again.holdout)).toBe(toMarkdown(offline.run, offline.meta, offline.holdout));
  });

  it("the audit chain is the same too, and verifies, with every verdict signed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wardy-agent-lab-"));
    dirs.push(dir);
    const [first, second] = [join(dir, "a.jsonl"), join(dir, "b.jsonl")];
    await runOffline({ auditPath: first });
    await runOffline({ auditPath: second });
    expect(readFileSync(first, "utf8")).toBe(readFileSync(second, "utf8"));
    const report = await verifyAuditLines(new AuditLog(first).lines(), await publicKeyOf(OFFLINE_TEST_SIGNING_KEY));
    expect(report.valid).toBe(true);
    expect(report.signaturesChecked).toBeGreaterThan(13);
  });
});

describe("the results", () => {
  it("say what the scripted agent is: a worst case, not a measurement", () => {
    expect(toMarkdown(offline.run, offline.meta)).toContain("not a measurement of any real model");
  });

  it("say plainly when the AI didn't run", () => {
    expect(offline.meta.aiSource).toContain("not run");
  });

  it("carry every verdict id, so a judge can find it", () => {
    const markdown = toMarkdown(offline.run, offline.meta);
    for (const scenario of offline.run.scenarios) {
      for (const step of scenario.with.steps) expect(markdown).toContain(step.verdictId.slice(0, 8));
    }
  });

  it("show the totals that were actually computed", () => {
    expect(summaryLine(offline.run.totals)).toBe("Lost without Wardy Agent: 27.36 NEAR + 25 USDC · Lost with Wardy Agent: 0 · Honest payments passed: 4/4 · False blocks: 0");
    expect(toMarkdown(offline.run, offline.meta)).toContain("Lost without Wardy Agent: 27.36 NEAR + 25 USDC. Lost with Wardy Agent: 0.");
  });

  it("the summary shows a line per scenario, then the totals", () => {
    const lines = summaryLines(offline.run);
    expect(lines[0]).toMatch(/^A1\s+lookalike\s+acme-sh0p\.near\s+BLOCK\s+\(LOOKALIKE_HOMOGLYPH\)$/);
    expect(lines[1]).toMatch(/^A2\s+retry\s+acme-shop\.near\s+ALLOW,HOLD\s+\(DUPLICATE_INVOICE\)$/);
    expect(lines.at(-1)).toContain("Honest payments passed: 4/4");
  });

  it("contain no invoice text and no approval token", () => {
    const everything = toJson(offline.run, offline.meta, offline.holdout) + toMarkdown(offline.run, offline.meta, offline.holdout);
    expect(everything).not.toContain("Note for the payment assistant");
    expect(everything).not.toContain("token=");
  });

  it("the network's reports verify on their own", async () => {
    const network = new ReportStore();
    await runLab(scenarios, context({ network }));
    expect(network.all().length).toBeGreaterThan(0);
    for (const report of network.all()) expect(await verifyReportEvidence(report), report.payee).toBe(true);
    expect(JSON.stringify(network.all())).not.toContain("our account has moved");
  });
});

describe("lossesFrom", () => {
  const debt = [{ payee: "a.near", asset: "wNEAR", amount: "2" }];
  const pay = (amount: string, payee = "a.near") => ({ payee, asset: WNEAR_ASSET, amount });

  it("paying what's owed loses nothing", () => {
    expect(lossesFrom([pay("2")], debt)).toEqual({});
  });

  it("paying less loses nothing", () => {
    expect(lossesFrom([pay("1")], debt)).toEqual({});
  });

  it("paying more loses the difference", () => {
    expect(lossesFrom([pay("10.36")], debt)).toEqual({ [WNEAR_ASSET]: "8.36" });
  });

  it("paying twice loses the second", () => {
    expect(lossesFrom([pay("2"), pay("2")], debt)).toEqual({ [WNEAR_ASSET]: "2" });
  });

  it("paying someone not owed loses it all", () => {
    expect(lossesFrom([pay("2", "b.near")], debt)).toEqual({ [WNEAR_ASSET]: "2" });
  });

  it("does exact arithmetic", () => {
    expect(lossesFrom([pay("0.1", "b.near"), pay("0.2", "b.near")], [])).toEqual({ [WNEAR_ASSET]: "0.3" });
  });
});

describe("the commands", () => {
  const run = (script: string, ...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", script, ...args], { encoding: "utf8" });

  it("npm run demo -- --offline prints the summary with no keys", () => {
    const result = run("scripts/demo.ts", "--offline");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Lost without Wardy Agent: 27.36 NEAR + 25 USDC · Lost with Wardy Agent: 0 · Honest payments passed: 4/4");
  }, 60_000);

  it("npm run agent shows what the agent read, what it asked, and the answer", () => {
    const result = run("apps/demo-agent/src/cli.ts", "--scenario", "lookalike");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("our account has moved");
    expect(result.stdout).toContain("asked Wardy Agent to pay 2 wNEAR to acme-sh0p.near");
    expect(result.stdout).toContain("BLOCK");
  }, 60_000);

  it("npm run agent lists the scenarios when asked for one that doesn't exist", () => {
    const result = run("apps/demo-agent/src/cli.ts", "--scenario", "nope");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("lookalike");
  }, 60_000);
});
