import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WNEAR_ASSET } from "../src/assets.js";
import { AuditLog, verifyAuditLines } from "../src/audit.js";
import { RequestIdConflictError } from "../src/checker.js";
import { Ledger } from "../src/ledger.js";
import { DEFAULT_POLICY, type OwnerPolicy } from "../src/policy.js";
import { type HoldNotice, PaymentService, ServiceError } from "../src/service.js";
import { generateSigningKey } from "../src/sign.js";
import type { AccountFacts, CustodyResult, CustodyTransfer, PaymentRequest } from "../src/types.js";
import { makeRequest, makeSettled, minutesAgo, NOW, OWNER } from "./helpers.js";

const KEY = generateSigningKey();
const NEW_ACCOUNTS: Record<string, Partial<AccountFacts>> = {
  "acme-sh0p.near": { createdAt: minutesAgo(120), txCount: 1 },
  "brand-new.near": { createdAt: minutesAgo(600), txCount: 1 },
};

class FakeCustody {
  readonly name = "fake";
  readonly transfers: CustodyTransfer[] = [];
  behaviour: () => CustodyResult | Promise<CustodyResult> = () => ({ status: "executed", provider: "fake", txHash: "tx-1" });

  async transfer(request: CustodyTransfer): Promise<CustodyResult> {
    // Yields first, the way a real network call does, so a race has a chance to show itself.
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.transfers.push(request);
    return this.behaviour();
  }
}

interface HarnessOptions {
  policy?: Partial<OwnerPolicy>;
  ledger?: Ledger;
  audit?: AuditLog;
  paid?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const ledger = options.ledger ?? new Ledger();
  const audit = options.audit ?? new AuditLog();
  const custody = new FakeCustody();
  const clock = { now: NOW };
  const holds: HoldNotice[] = [];
  const blocked: string[] = [];
  // By default the owner has paid acme-shop.near before, so a clean payment to it is ALLOW.
  if (options.paid !== false && ledger.knownPayees(OWNER).length === 0) {
    ledger.recordSettled(makeSettled({ amount: "1", settledAt: minutesAgo(60 * 24 * 40) }));
  }
  const service = new PaymentService({
    ledger,
    audit,
    seedPayees: [],
    chainData: {
      getAccountFacts: async (accountId) => ({
        accountId,
        available: true,
        exists: true,
        implicit: false,
        createdAt: "2023-01-01T00:00:00.000Z",
        txCount: 100,
        ...NEW_ACCOUNTS[accountId],
      }),
    },
    reportsFor: () => [],
    reportRules: { trustedReporters: new Set(), verifyEvidence: () => false, allowSeedReports: false },
    signingKey: KEY,
    now: () => clock.now,
    custody,
    fleetOwnerId: OWNER,
    policy: { ...DEFAULT_POLICY, ...options.policy },
    approvalUrl: (verdictId, token) => `https://owner.test/approve/${verdictId}?token=${token}`,
    onBlocked: (verdict) => {
      blocked.push(verdict.verdictId);
    },
  });
  service.on("hold", (notice) => holds.push(notice));
  const tokenOf = (notice: HoldNotice | undefined) => new URL(notice?.approvalUrl as string).searchParams.get("token") as string;
  return { service, ledger, audit, custody, clock, holds, blocked, tokenOf };
}

/** A payment that's clean, and to a payee already paid, so it comes out ALLOW. */
function clean(overrides: Partial<PaymentRequest> = {}) {
  return makeRequest({ amount: "2", ...overrides });
}

/** A first payment to an old account: HOLD, because the owner asked to approve new payees. */
function newPayee(overrides: Partial<PaymentRequest> = {}) {
  return makeRequest({ payee: "old-but-new-to-you.near", amount: "2", ...overrides });
}

async function expectRefusal(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => null,
    (caught) => caught,
  );
  expect(error).toBeInstanceOf(ServiceError);
  expect(error).toMatchObject({ status, code });
}

describe("ALLOW", () => {
  it("pays once, with the request id as the idempotency key and the verdict id as the memo", async () => {
    const { service, custody } = harness();
    const request = clean();
    const verdict = await service.pay(request);
    expect(verdict.decision).toBe("ALLOW");
    expect(verdict.execution).toEqual({ status: "executed", provider: "fake", txHash: "tx-1" });
    expect(custody.transfers).toEqual([
      { to: "acme-shop.near", asset: WNEAR_ASSET, amount: "2", memo: verdict.verdictId, idempotencyKey: request.requestId },
    ]);
  });

  it("records the settled payment, with only a hash of the invoice text", async () => {
    const { service, ledger } = harness();
    const request = clean({ invoiceId: "INV-1", context: { invoiceText: "SENTINEL invoice words" } });
    await service.pay(request);
    const settled = ledger.snapshot(OWNER).settled.at(-1);
    expect(settled).toMatchObject({ requestId: request.requestId, invoiceId: "INV-1", txHash: "tx-1" });
    expect(settled?.invoiceTextHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(ledger.snapshot(OWNER))).not.toContain("SENTINEL");
  });

  it("the same request twice pays once and returns the first answer", async () => {
    const { service, custody } = harness();
    const request = clean();
    const first = await service.pay(request);
    expect(await service.pay(request)).toEqual(first);
    expect(custody.transfers).toHaveLength(1);
  });
});

describe("the double-payment race", () => {
  it("two identical payments at the same moment: one pays, the other asks", async () => {
    const { service, custody } = harness();
    const [first, second] = await Promise.all([service.pay(clean({ invoiceId: "INV-7" })), service.pay(clean({ invoiceId: "INV-7" }))]);
    expect(custody.transfers).toHaveLength(1);
    expect([first.decision, second.decision]).toEqual(["ALLOW", "HOLD"]);
    expect(second.execution?.status).toBe("pending_owner");
  });

  it("ten identical payments at the same moment still pay once", async () => {
    const { service, custody } = harness();
    await Promise.all(Array.from({ length: 10 }, () => service.pay(clean({ invoiceId: "INV-8" }))));
    expect(custody.transfers).toHaveLength(1);
  });

  it("parallel payments can't sneak past the daily budget", async () => {
    const { service, custody } = harness({ policy: { dailyBudget: "5" } });
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) => service.pay(clean({ amount: "2", invoiceId: `B-${index}`, payee: "acme-shop.near" }))));
    const paid = results.filter((verdict) => verdict.execution?.status === "executed");
    expect(paid.length).toBeLessThanOrEqual(2);
    expect(custody.transfers.length).toBe(paid.length);
  });

  it("the same requestId at the same moment pays once", async () => {
    const { service, custody } = harness();
    const request = clean();
    const [first, second] = await Promise.all([service.pay(request), service.pay(request)]);
    expect(custody.transfers).toHaveLength(1);
    expect(second.verdictId).toBe(first.verdictId);
  });

  it("one failed payment doesn't stop the ones queued behind it", async () => {
    const { service, custody } = harness();
    custody.behaviour = () => Promise.reject(new Error("boom"));
    const failing = service.pay(clean({ invoiceId: "F-1", amount: "1" }));
    const invalid = service.pay({ nonsense: true }).catch(() => "refused");
    await failing;
    custody.behaviour = () => ({ status: "executed", provider: "fake", txHash: "tx-2" });
    expect(await invalid).toBe("refused");
    expect((await service.pay(clean({ invoiceId: "F-2", amount: "2", payee: "acme-shop.near" }))).execution?.status).toBe("executed");
  });
});

describe("when custody goes wrong", () => {
  it("a proven failure isn't recorded as paid, so paying again is fine", async () => {
    const { service, custody, ledger } = harness();
    const settledBefore = ledger.snapshot(OWNER).settled.length;
    custody.behaviour = () => ({ status: "failed", provider: "fake", failureCode: "insufficient_balance" });
    const verdict = await service.pay(clean());
    expect(verdict.execution).toMatchObject({ status: "failed", failureCode: "insufficient_balance" });
    expect(ledger.snapshot(OWNER).settled).toHaveLength(settledBefore);
    custody.behaviour = () => ({ status: "executed", provider: "fake", txHash: "tx-2" });
    expect((await service.pay(clean())).decision).toBe("ALLOW");
  });

  it("no answer means unknown, not failed: a retry is held instead of paying twice", async () => {
    const { service, custody } = harness();
    custody.behaviour = () => Promise.reject(new Error("connection lost"));
    const first = await service.pay(clean({ invoiceId: "INV-9" }));
    expect(first.execution).toMatchObject({ status: "uncertain", failureCode: "custody_no_answer" });
    custody.behaviour = () => ({ status: "executed", provider: "fake", txHash: "tx-2" });
    const retry = await service.pay(clean({ invoiceId: "INV-9" }));
    expect(retry.decision).toBe("HOLD");
    expect(custody.transfers).toHaveLength(1);
  });

  it("an uncertain answer from custody is treated the same way", async () => {
    const { service, custody, ledger } = harness();
    custody.behaviour = () => ({ status: "uncertain", provider: "fake", failureCode: "needs_review", reference: "op_1" });
    const verdict = await service.pay(clean());
    expect(verdict.execution).toMatchObject({ status: "uncertain", reference: "op_1" });
    expect(verdict.execution?.note).toContain("Check it before paying again");
    expect(ledger.snapshot(OWNER).settled.at(-1)).toMatchObject({ uncertain: true });
  });

  it("resumes after a crash between deciding and paying, with the same idempotency key", async () => {
    const { service, custody, ledger } = harness();
    const request = clean();
    // The crash: a verdict saved, with no execution yet.
    const first = await service.pay(request);
    const { execution: _execution, ...beforePaying } = first;
    ledger.saveVerdict(beforePaying);
    const resumed = await service.pay(request);
    expect(resumed.execution?.status).toBe("executed");
    expect(custody.transfers.map((transfer) => transfer.idempotencyKey)).toEqual([request.requestId, request.requestId]);
  });

  it("a chain custody can't pay on fails plainly and moves nothing", async () => {
    const { service, custody, ledger } = harness();
    const address = "0xabcdef0000000000000000000000000000000001";
    ledger.recordSettled(makeSettled({ payee: address, chain: "base", amount: "1", settledAt: minutesAgo(60 * 24 * 40) }));
    const verdict = await service.pay(clean({ payee: address, chain: "base" }));
    expect(verdict.decision).toBe("ALLOW");
    expect(verdict.execution).toMatchObject({ status: "failed", failureCode: "chain_not_supported" });
    expect(custody.transfers).toEqual([]);
  });
});

describe("BLOCK", () => {
  it("refuses, moves nothing, and tells the Network hook", async () => {
    const { service, custody, blocked, holds } = harness();
    const verdict = await service.pay(makeRequest({ payee: "acme-sh0p.near" }));
    expect(verdict.decision).toBe("BLOCK");
    expect(verdict.execution?.status).toBe("refused");
    expect(custody.transfers).toEqual([]);
    expect(blocked).toEqual([verdict.verdictId]);
    expect(holds).toEqual([]);
  });

  it("replaying a BLOCK doesn't tell the hook twice", async () => {
    const { service, blocked } = harness();
    const request = makeRequest({ payee: "acme-sh0p.near" });
    await service.pay(request);
    await service.pay(request);
    expect(blocked).toHaveLength(1);
  });
});

describe("HOLD", () => {
  it("moves nothing, and gives the owner a link that the verdict itself doesn't contain", async () => {
    const { service, custody, holds, tokenOf } = harness();
    const verdict = await service.pay(newPayee());
    expect(verdict.decision).toBe("HOLD");
    expect(verdict.execution?.status).toBe("pending_owner");
    expect(custody.transfers).toEqual([]);
    expect(holds).toHaveLength(1);
    expect(tokenOf(holds[0])).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(verdict)).not.toContain(tokenOf(holds[0]));
  });

  it("the token appears nowhere on disk: only its hash is stored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wardy-agent-service-"));
    try {
      const { service, holds, tokenOf } = harness({ ledger: new Ledger(join(dir, "ledger.jsonl")), audit: new AuditLog(join(dir, "audit.jsonl")) });
      await service.pay(newPayee());
      const token = tokenOf(holds[0]);
      expect(readFileSync(join(dir, "ledger.jsonl"), "utf8")).not.toContain(token);
      expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).not.toContain(token);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("approve pays, once, and the audit chain records who decided", async () => {
    const { service, custody, holds, tokenOf, audit } = harness();
    const held = await service.pay(newPayee());
    const approved = await service.decideHold(held.verdictId, "approve", tokenOf(holds[0]));
    expect(approved.execution?.status).toBe("executed");
    expect(custody.transfers).toHaveLength(1);
    expect(audit.lines().join("\n")).toContain('"action":"approve"');
    expect((await verifyAuditLines(audit.lines())).valid).toBe(true);
  });

  it("approving records the payment with its invoice details, so a later copy is caught", async () => {
    const { service, holds, tokenOf } = harness();
    const held = await service.pay(newPayee({ invoiceId: "INV-55", context: { invoiceText: "Some invoice" } }));
    await service.decideHold(held.verdictId, "approve", tokenOf(holds[0]));
    const again = await service.pay(newPayee({ invoiceId: "INV-55", amount: "1", context: { emailText: "reminder" } }));
    expect(again.signals.map((signal) => signal.code)).toContain("DUPLICATE_INVOICE");
  });

  it("the payee counts as known after that first approved payment", async () => {
    const { service, holds, tokenOf } = harness();
    const held = await service.pay(newPayee());
    await service.decideHold(held.verdictId, "approve", tokenOf(holds[0]));
    const next = await service.pay(newPayee({ invoiceId: "NEXT", amount: "1" }));
    expect(next.decision).toBe("ALLOW");
    expect(next.execution?.status).toBe("executed");
  });

  it("reject refuses and moves nothing", async () => {
    const { service, custody, holds, tokenOf } = harness();
    const held = await service.pay(newPayee());
    const rejected = await service.decideHold(held.verdictId, "reject", tokenOf(holds[0]));
    expect(rejected.execution).toMatchObject({ status: "refused", note: "You rejected this payment." });
    expect(custody.transfers).toEqual([]);
  });

  it("a token works only once", async () => {
    const { service, custody, holds, tokenOf } = harness();
    const held = await service.pay(newPayee());
    const token = tokenOf(holds[0]);
    await service.decideHold(held.verdictId, "approve", token);
    await expectRefusal(service.decideHold(held.verdictId, "approve", token), 409, "not_pending");
    expect(custody.transfers).toHaveLength(1);
  });

  it.each([
    ["no token", ""],
    ["a wrong token", "f".repeat(64)],
    ["garbage", "not hex at all"],
  ])("refuses %s", async (_name, token) => {
    const { service, custody } = harness();
    const held = await service.pay(newPayee());
    await expectRefusal(service.decideHold(held.verdictId, "approve", token), 401, "invalid_token");
    expect(custody.transfers).toEqual([]);
  });

  it("a token for one payment can't approve another", async () => {
    const { service, custody, holds, tokenOf } = harness();
    const first = await service.pay(newPayee({ payee: "first-new.near" }));
    const second = await service.pay(newPayee({ payee: "second-new.near" }));
    expect(first.decision).toBe("HOLD");
    await expectRefusal(service.decideHold(second.verdictId, "approve", tokenOf(holds[0])), 401, "invalid_token");
    expect(custody.transfers).toEqual([]);
  });

  it("an unknown verdict is a 404", async () => {
    await expectRefusal(harness().service.decideHold(crypto.randomUUID(), "approve", "x"), 404, "not_found");
  });

  it("an ALLOW has nothing to approve", async () => {
    const { service } = harness();
    const verdict = await service.pay(clean());
    await expectRefusal(service.decideHold(verdict.verdictId, "approve", "x"), 409, "not_pending");
  });

  describe("expiry", () => {
    it("after 30 minutes the link is dead and the payment is refused", async () => {
      const { service, custody, holds, tokenOf, clock } = harness();
      const held = await service.pay(newPayee());
      clock.now = new Date(NOW.getTime() + 30 * 60_000);
      await expectRefusal(service.decideHold(held.verdictId, "approve", tokenOf(holds[0])), 409, "not_pending");
      expect(service.getVerdict(held.verdictId)?.execution).toMatchObject({ status: "refused", note: expect.stringContaining("in time") });
      expect(custody.transfers).toEqual([]);
    });

    it("just before 30 minutes it still works", async () => {
      const { service, holds, tokenOf, clock } = harness();
      const held = await service.pay(newPayee());
      clock.now = new Date(NOW.getTime() + 30 * 60_000 - 1);
      expect((await service.decideHold(held.verdictId, "approve", tokenOf(holds[0]))).execution?.status).toBe("executed");
    });

    it("the sweep clears expired holds on its own", async () => {
      const { service, clock } = harness();
      await service.pay(newPayee());
      expect(service.pendingHolds()).toHaveLength(1);
      clock.now = new Date(NOW.getTime() + 31 * 60_000);
      service.expireHolds();
      expect(service.pendingHolds()).toEqual([]);
      expect(service.stats().heldNow).toBe(0);
    });
  });

  it("a renewed link replaces the old one", async () => {
    const { service, holds, tokenOf, custody } = harness();
    const held = await service.pay(newPayee());
    const renewed = service.renewApprovalLink(held.verdictId);
    await expectRefusal(service.decideHold(held.verdictId, "approve", tokenOf(holds[0])), 401, "invalid_token");
    const token = new URL(renewed.approvalUrl).searchParams.get("token") as string;
    expect((await service.decideHold(held.verdictId, "approve", token)).execution?.status).toBe("executed");
    expect(custody.transfers).toHaveLength(1);
  });

  it("can't renew a link for a decided payment", async () => {
    const { service, holds, tokenOf } = harness();
    const held = await service.pay(newPayee());
    await service.decideHold(held.verdictId, "reject", tokenOf(holds[0]));
    expect(() => service.renewApprovalLink(held.verdictId)).toThrow(ServiceError);
  });

  it("re-checks the hard limits on approval: the budget may be gone by then", async () => {
    const { service, custody, holds, tokenOf, ledger } = harness({ policy: { dailyBudget: "3" } });
    const held = await service.pay(newPayee());
    ledger.recordSettled(makeSettled({ amount: "2", settledAt: NOW.toISOString(), payee: "other.near" }));
    const verdict = await service.decideHold(held.verdictId, "approve", tokenOf(holds[0]));
    expect(verdict.execution).toMatchObject({ status: "refused", note: expect.stringContaining("budget") });
    expect(custody.transfers).toEqual([]);
  });
});

describe("freeze", () => {
  it("stops all execution at once", async () => {
    const { service, custody } = harness();
    service.freeze();
    const verdict = await service.pay(clean());
    expect(verdict.decision).toBe("BLOCK");
    expect(verdict.signals.map((signal) => signal.code)).toContain("POLICY_FROZEN");
    expect(custody.transfers).toEqual([]);
  });

  it("unfreezing brings payments back", async () => {
    const { service } = harness();
    service.freeze();
    service.unfreeze();
    expect((await service.pay(clean())).execution?.status).toBe("executed");
  });

  it("an approval can't get through a freeze, and the link still works afterwards", async () => {
    const { service, custody, holds, tokenOf } = harness();
    const held = await service.pay(newPayee());
    service.freeze();
    await expectRefusal(service.decideHold(held.verdictId, "approve", tokenOf(holds[0])), 409, "frozen");
    expect(custody.transfers).toEqual([]);
    service.unfreeze();
    expect((await service.decideHold(held.verdictId, "approve", tokenOf(holds[0]))).execution?.status).toBe("executed");
  });

  it("rejecting still works while frozen", async () => {
    const { service, holds, tokenOf } = harness();
    const held = await service.pay(newPayee());
    service.freeze();
    expect((await service.decideHold(held.verdictId, "reject", tokenOf(holds[0]))).execution?.status).toBe("refused");
  });

  it("survives a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "wardy-agent-freeze-"));
    try {
      const path = join(dir, "ledger.jsonl");
      harness({ ledger: new Ledger(path) }).service.freeze();
      expect(harness({ ledger: new Ledger(path) }).service.isFrozen()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is recorded in the audit chain", () => {
    const { service, audit } = harness();
    service.freeze();
    service.freeze(); // Only a real change is recorded.
    service.unfreeze();
    expect(audit.lines().map((line) => JSON.parse(line).entry.type)).toEqual(["freeze", "unfreeze"]);
  });

  it("an owner's policy that starts frozen stays frozen after unfreeze", () => {
    const { service } = harness({ policy: { frozen: true } });
    service.unfreeze();
    expect(service.isFrozen()).toBe(true);
  });
});

describe("who can pay", () => {
  it("refuses any owner but the one this instance spends for", async () => {
    const { service, custody } = harness();
    await expectRefusal(service.pay(clean({ ownerId: "someone-else.near" })), 403, "unknown_owner");
    expect(custody.transfers).toEqual([]);
  });

  it("refuses a reused request id for a different payment", async () => {
    const { service, custody } = harness();
    const request = clean();
    await service.pay(request);
    await expect(service.pay({ ...request, amount: "1" })).rejects.toBeInstanceOf(RequestIdConflictError);
    expect(custody.transfers).toHaveLength(1);
  });
});

describe("check", () => {
  it("never moves money, even on ALLOW", async () => {
    const { service, custody } = harness();
    const verdict = await service.check(clean());
    expect(verdict.decision).toBe("ALLOW");
    expect(verdict.mode).toBe("check");
    expect(verdict.execution).toBeUndefined();
    expect(custody.transfers).toEqual([]);
  });

  it("a HOLD from a check creates no approval", async () => {
    const { service, holds } = harness();
    expect((await service.check(newPayee())).decision).toBe("HOLD");
    expect(holds).toEqual([]);
    expect(service.pendingHolds()).toEqual([]);
  });

  it("a BLOCK from a check doesn't reach the Network hook", async () => {
    const { service, blocked } = harness();
    await service.check(makeRequest({ payee: "acme-sh0p.near" }));
    expect(blocked).toEqual([]);
  });

  it("checking first doesn't stop the payment, even with the same request id", async () => {
    const { service, custody } = harness();
    const request = clean();
    await service.check(request);
    expect((await service.pay(request)).execution?.status).toBe("executed");
    expect(custody.transfers).toHaveLength(1);
  });

  it("asking repeatedly doesn't look like a split-payment attack", async () => {
    const { service } = harness();
    for (let index = 0; index < 5; index += 1) await service.check(newPayee({ payee: "brand-new.near" }));
    const verdict = await service.pay(newPayee({ payee: "brand-new.near" }));
    expect(verdict.signals.map((signal) => signal.code)).not.toContain("VELOCITY_NEW_PAYEE");
  });

  it("another owner's check doesn't get this owner's limits, freeze or history", async () => {
    const { service } = harness({ policy: { maxPerPayment: "1" } });
    service.freeze();
    const verdict = await service.check(makeRequest({ ownerId: "someone-else.near", payee: "old-account.near", amount: "500" }));
    expect(verdict.decision).toBe("ALLOW");
    expect(verdict.signals.filter((signal) => signal.detector === "policy")).toEqual([]);
  });
});

describe("stats", () => {
  it("counts real verdicts, and counts as saved only what looked like an attack", async () => {
    const { service, holds, tokenOf } = harness();
    expect(service.stats()).toMatchObject({ checkedToday: 0, blockedToday: 0, heldNow: 0, saved: [], checksForOthers: 0 });
    await service.pay(clean());
    await service.pay(makeRequest({ payee: "acme-sh0p.near", amount: "2" })); // An attack: saved.
    await service.pay(clean({ amount: "9", invoiceId: "BIG" })); // Over a limit, with no other red flag: not a scam.
    const held = await service.pay(newPayee({ amount: "1.5" }));
    await service.check(makeRequest({ ownerId: "someone-else.near", payee: "old-account.near" }));
    expect(service.stats()).toMatchObject({
      checkedToday: 5,
      blockedToday: 2,
      heldNow: 1,
      paidToday: 1,
      checksForOthers: 1,
      saved: [{ asset: WNEAR_ASSET, amount: "2" }],
    });
    await service.decideHold(held.verdictId, "approve", tokenOf(holds[0]));
    expect(service.stats().heldNow).toBe(0);
  });
});

describe("events", () => {
  it("the verdict stream carries updates and never a token", async () => {
    const { service, holds, tokenOf } = harness();
    const seen: string[] = [];
    service.on("verdict", (verdict) => seen.push(JSON.stringify(verdict)));
    const held = await service.pay(newPayee());
    await service.decideHold(held.verdictId, "approve", tokenOf(holds[0]));
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.join("")).not.toContain(tokenOf(holds[0]));
    expect(JSON.parse(seen.at(-1) as string).execution.status).toBe("executed");
  });
});

describe("signatures after a payment", () => {
  it("execution updates leave the signature valid", async () => {
    const { service } = harness();
    const verdict = await service.pay(clean());
    expect(verdict.execution?.status).toBe("executed");
    expect(await service.verify(verdict)).toBe(true);
    expect(await service.verify({ ...verdict, payee: "attacker.near" })).toBe(false);
  });
});
