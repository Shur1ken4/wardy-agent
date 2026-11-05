// The real command spends real money, so its flow is tested on the mock ledger.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wire } from "@wardy-agent/api";
import { verifyVerdict } from "@wardy-agent/core";
import { MockCustody } from "@wardy-agent/providers";
import { afterEach, describe, expect, it } from "vitest";
import { FIRST_AMOUNT, runLivePayment, SECOND_AMOUNT } from "../live-pay.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function run(answers: string[], payee = "acme-shop.near", custody = new MockCustody({ "nep141:wrap.near": "1" })) {
  const dataDir = mkdtempSync(join(tmpdir(), "wardy-agent-live-pay-"));
  dirs.push(dataDir);
  const wiring = await wire({}, { dataDir, seedHistory: false, custody });
  const lines: string[] = [];
  const outcome = await runLivePayment({ wiring, payee, ask: async () => answers.shift() ?? "", log: (line) => lines.push(line) });
  return { outcome, output: lines.join("\n"), custody };
}

describe("the saved real payment", () => {
  it("is an ALLOW that really paid, with a verified attestation and a signature that checks", async () => {
    const verdict = JSON.parse(readFileSync("docs/evidence/attested-verdict.live.json", "utf8"));
    expect(verdict.decision).toBe("ALLOW");
    expect(verdict.ai.attested).toBe(true);
    expect(verdict.execution).toMatchObject({ status: "executed", provider: "agent-connect" });
    expect(await verifyVerdict(verdict, verdict.wardyPublicKey)).toBe(true);
    expect(await verifyVerdict({ ...verdict, amount: "2000" }, verdict.wardyPublicKey)).toBe(false);
  });
});

describe("the live payment flow", () => {
  it("holds a new payee, pays once the owner approves, then allows the next with no human", async () => {
    const { outcome, output, custody } = await run(["approve", "yes"]);
    expect(outcome).toBe("done");
    expect(output).toContain("Decision:  HOLD");
    expect(output).toContain("Decision:  ALLOW");
    expect(output).toContain("paid with no human");
    expect(custody.transfers.map((transfer) => transfer.amount)).toEqual([FIRST_AMOUNT, SECOND_AMOUNT]);
  });

  it("pays nothing when the owner rejects", async () => {
    const { outcome, custody } = await run(["reject"]);
    expect(outcome).toBe("stopped");
    expect(custody.transfers).toEqual([]);
  });

  it("treats anything but the word approve as a rejection", async () => {
    const { outcome, custody } = await run(["yes"]);
    expect(outcome).toBe("stopped");
    expect(custody.transfers).toEqual([]);
  });

  it("stops after one payment if the owner doesn't continue", async () => {
    const { outcome, custody } = await run(["approve", "no"]);
    expect(outcome).toBe("stopped");
    expect(custody.transfers).toHaveLength(1);
  });

  it("pays nothing to a lookalike", async () => {
    // The first payment makes acme-shop.near known, so the lookalike has someone to imitate.
    const dataDir = mkdtempSync(join(tmpdir(), "wardy-agent-live-pay-"));
    dirs.push(dataDir);
    const custody = new MockCustody({ "nep141:wrap.near": "1" });
    const wiring = await wire({}, { dataDir, seedHistory: true, custody });
    const outcome = await runLivePayment({ wiring, payee: "acme-sh0p.near", ask: async () => "approve", log: () => {} });
    expect(outcome).toBe("stopped");
    expect(custody.transfers).toEqual([]);
  });

  it("says not to retry when custody can't say whether it paid, and never offers a second payment", async () => {
    const custody = new MockCustody({ "nep141:wrap.near": "1" });
    custody.transfer = async () => ({ status: "uncertain", provider: "mock", failureCode: "status_timeout" });
    const asked: string[] = [];
    const dataDir = mkdtempSync(join(tmpdir(), "wardy-agent-live-pay-"));
    dirs.push(dataDir);
    const wiring = await wire({}, { dataDir, seedHistory: false, custody });
    const lines: string[] = [];
    const outcome = await runLivePayment({
      wiring,
      payee: "acme-shop.near",
      ask: async (question) => {
        asked.push(question);
        return "approve";
      },
      log: (line) => lines.push(line),
    });
    expect(outcome).toBe("unexpected");
    expect(lines.join("\n")).toContain("DON'T run this again");
    expect(asked).toHaveLength(1);
  });
});
