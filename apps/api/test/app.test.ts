import { AuditLog, DEFAULT_POLICY, generateSigningKey, type HoldNotice, Ledger, NetworkQuery, PaymentService, ReportStore, signVerdict, verifyVerdict, WNEAR_ASSET } from "@wardy-agent/core";
import { MockChainData, MockCustody, OFFLINE_ACCOUNTS } from "@wardy-agent/providers";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { type AppOptions, buildApp, type DemoTools } from "../src/app.js";

const OWNER = "demo-owner.near";
const AGENT_TOKEN = "agent-secret-token";
const OWNER_TOKEN = "owner-secret-token";
const open: FastifyInstance[] = [];

async function harness(options: Partial<AppOptions> = {}) {
  const ledger = new Ledger();
  const custody = new MockCustody({ [WNEAR_ASSET]: "100" });
  const holds: HoldNotice[] = [];
  const service = new PaymentService({
    ledger,
    audit: new AuditLog(),
    seedPayees: [],
    chainData: new MockChainData(OFFLINE_ACCOUNTS),
    reportsFor: () => [],
    reportRules: { trustedReporters: new Set(), verifyEvidence: () => false, allowSeedReports: false },
    signingKey: generateSigningKey(),
    custody,
    fleetOwnerId: OWNER,
    policy: DEFAULT_POLICY,
    approvalUrl: (verdictId, token) => `http://localhost:5173/approve/${verdictId}?token=${token}`,
  });
  service.on("hold", (notice) => holds.push(notice));
  const app = await buildApp({
    service,
    network: new NetworkQuery(new ReportStore(), { trustedReporters: new Set(), verifyEvidence: () => false, allowSeedReports: false }, () => null),
    agentToken: AGENT_TOKEN,
    ownerToken: OWNER_TOKEN,
    mode: "offline",
    ...options,
  });
  open.push(app);
  const agent = { authorization: `Bearer ${AGENT_TOKEN}` };
  const owner = { authorization: `Bearer ${OWNER_TOKEN}` };
  const body = (overrides: Record<string, unknown> = {}) => ({
    requestId: crypto.randomUUID(),
    agentId: "procure-bot",
    ownerId: OWNER,
    payee: "acme-shop.near",
    asset: "wNEAR",
    amount: "2",
    purpose: "supplies",
    createdAt: new Date().toISOString(),
    ...overrides,
  });
  const pay = (payload: Record<string, unknown> = body(), headers: Record<string, string> = agent) =>
    app.inject({ method: "POST", url: "/v1/pay", headers, payload });
  /** Makes acme-shop.near a payee the owner has paid. */
  const makeKnown = () =>
    ledger.recordSettled({
      requestId: crypto.randomUUID(),
      ownerId: OWNER,
      payee: "acme-shop.near",
      chain: "near",
      asset: WNEAR_ASSET,
      amount: "1",
      settledAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
    });
  const tokenOf = (notice: HoldNotice | undefined) => new URL(notice?.approvalUrl as string).searchParams.get("token") as string;
  return { app, service, ledger, custody, holds, agent, owner, body, pay, makeKnown, tokenOf };
}

afterEach(async () => {
  for (const app of open.splice(0)) await app.close();
});

describe("POST /v1/pay", () => {
  it("needs the agent credential", async () => {
    const { pay, body } = await harness();
    expect((await pay(body(), {})).statusCode).toBe(401);
    expect((await pay(body(), { authorization: "Bearer wrong" })).statusCode).toBe(401);
    expect((await pay(body(), { authorization: `Bearer ${OWNER_TOKEN}` })).statusCode).toBe(401);
  });

  it("pays on ALLOW and returns the verdict with its execution", async () => {
    const { pay, makeKnown, custody } = await harness();
    makeKnown();
    const response = await pay();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ decision: "ALLOW", agentId: "procure-bot", execution: { status: "executed", provider: "mock" } });
    expect(custody.transfers).toHaveLength(1);
  });

  it("refuses on BLOCK", async () => {
    const { pay, makeKnown, custody } = await harness();
    makeKnown();
    const response = await pay({ ...(await harness()).body(), payee: "acme-sh0p.near" });
    expect(response.json()).toMatchObject({ decision: "BLOCK", execution: { status: "refused" } });
    expect(custody.transfers).toEqual([]);
  });

  it("holds without paying, and the response gives the agent nothing to approve with", async () => {
    const { pay, holds, custody, tokenOf } = await harness();
    const response = await pay();
    expect(response.json()).toMatchObject({ decision: "HOLD", execution: { status: "pending_owner" } });
    expect(custody.transfers).toEqual([]);
    expect(response.body).not.toContain(tokenOf(holds[0]));
    expect(response.body).not.toContain("approve/");
  });

  it("replays return the same answer", async () => {
    const { pay, body, makeKnown, custody } = await harness();
    makeKnown();
    const payload = body();
    const first = await pay(payload);
    const second = await pay(payload);
    expect(second.json()).toEqual(first.json());
    expect(custody.transfers).toHaveLength(1);
  });

  it("a reused request id for a different payment is a 409", async () => {
    const { pay, body, makeKnown } = await harness();
    makeKnown();
    const payload = body();
    await pay(payload);
    const response = await pay({ ...payload, amount: "1" });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("request_id_conflict");
  });

  it("another owner gets a 403", async () => {
    const { pay, body } = await harness();
    expect((await pay(body({ ownerId: "stranger.near" }))).statusCode).toBe(403);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a missing payee", { payee: undefined }],
    ["a negative amount", { amount: "-5" }],
    ["a zero amount", { amount: "0" }],
    ["an amount in scientific notation", { amount: "1e3" }],
    ["a request id that isn't a uuid", { requestId: "abc" }],
    ["an unknown field", { surprise: true }],
    ["a bad date", { createdAt: "yesterday" }],
  ])("refuses %s with a 400 and says where", async (_name, change) => {
    const { pay, body, custody } = await harness();
    const response = await pay(body(change));
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_request");
    expect(response.json().issues.length).toBeGreaterThan(0);
    expect(custody.transfers).toEqual([]);
  });

  it("errors never repeat what was sent, so untrusted text can't leak back out", async () => {
    const { pay, body } = await harness();
    const secret = "SENTINEL-PRIVATE-INVOICE";
    const response = await pay(body({ amount: "not-a-number", context: { invoiceText: secret, extra: secret } }));
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(secret);
  });

  it("verdicts never repeat the invoice text either", async () => {
    const { pay, body } = await harness();
    const response = await pay(body({ context: { invoiceText: "SENTINEL our account has moved" } }));
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("SENTINEL");
  });

  it("refuses bad JSON and a wrong content type without crashing", async () => {
    const { app, agent } = await harness();
    const bad = await app.inject({ method: "POST", url: "/v1/pay", headers: { ...agent, "content-type": "application/json" }, payload: "{oops" });
    expect(bad.statusCode).toBe(400);
    const wrongType = await app.inject({ method: "POST", url: "/v1/pay", headers: { ...agent, "content-type": "text/plain" }, payload: "hello" });
    expect(wrongType.statusCode).toBe(400);
    const unknownType = await app.inject({ method: "POST", url: "/v1/pay", headers: { ...agent, "content-type": "application/xml" }, payload: "<a/>" });
    expect(unknownType.statusCode).toBe(415);
  });

  it("refuses an oversized body", async () => {
    const { pay, body } = await harness();
    const response = await pay(body({ purpose: "x".repeat(300 * 1024) }));
    expect(response.statusCode).toBe(413);
  });
});

describe("POST /v1/check", () => {
  it("never moves money", async () => {
    const { app, body, makeKnown, custody } = await harness();
    makeKnown();
    const response = await app.inject({ method: "POST", url: "/v1/check", headers: { authorization: `Bearer ${AGENT_TOKEN}` }, payload: body() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ decision: "ALLOW", mode: "check" });
    expect(response.json().execution).toBeUndefined();
    expect(custody.transfers).toEqual([]);
  });

  it("another owner's agent needs no credential, and gets nothing of this owner's", async () => {
    const { app, body, makeKnown } = await harness();
    makeKnown();
    const response = await app.inject({ method: "POST", url: "/v1/check", payload: body({ ownerId: "someone-else.near", amount: "99" }) });
    expect(response.statusCode).toBe(200);
    const codes = response.json().signals.map((signal: { code: string }) => signal.code);
    expect(codes).not.toContain("KNOWN_PAYEE");
    expect(codes.filter((code: string) => code.startsWith("POLICY_"))).toEqual([]);
  });

  it("a stranger can't ask as this owner: no history, no limits, and nothing recorded", async () => {
    const { app, body, makeKnown } = await harness();
    makeKnown();
    for (const headers of [{}, { authorization: "Bearer wrong" }]) {
      const response = await app.inject({ method: "POST", url: "/v1/check", headers, payload: body({ amount: "99" }) });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain("KNOWN_PAYEE");
      expect(response.body).not.toContain("POLICY_");
    }
    const owner = { authorization: `Bearer ${OWNER_TOKEN}` };
    expect((await app.inject({ method: "GET", url: "/v1/verdicts", headers: owner })).json().verdicts).toEqual([]);
  });

  it.each([["agent", AGENT_TOKEN], ["owner", OWNER_TOKEN]])("the %s's credential can ask as this owner", async (_who, token) => {
    const { app, body, makeKnown } = await harness();
    makeKnown();
    const response = await app.inject({ method: "POST", url: "/v1/check", headers: { authorization: `Bearer ${token}` }, payload: body() });
    expect(response.statusCode).toBe(200);
    expect(response.json().signals.map((signal: { code: string }) => signal.code)).toContain("KNOWN_PAYEE");
  });

  it("is rate limited", async () => {
    const { app, body } = await harness({ checkRateLimitPerMinute: 2 });
    const send = () => app.inject({ method: "POST", url: "/v1/check", payload: body({ ownerId: "someone-else.near" }) });
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(429);
  });

  it("validates its input", async () => {
    const { app, body } = await harness();
    expect((await app.inject({ method: "POST", url: "/v1/check", payload: body({ ownerId: "someone-else.near", amount: "abc" }) })).statusCode).toBe(400);
  });
});

describe("POST /v1/approve/:id", () => {
  const approve = (app: FastifyInstance, id: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/v1/approve/${id}`, payload });

  it("the owner's token approves and pays, once", async () => {
    const { app, pay, holds, custody, tokenOf } = await harness();
    const { verdictId } = (await pay()).json();
    const response = await approve(app, verdictId, { action: "approve", ownerToken: tokenOf(holds[0]) });
    expect(response.statusCode).toBe(200);
    expect(response.json().execution.status).toBe("executed");
    expect(custody.transfers).toHaveLength(1);
    const again = await approve(app, verdictId, { action: "approve", ownerToken: tokenOf(holds[0]) });
    expect(again.statusCode).toBe(409);
    expect(custody.transfers).toHaveLength(1);
  });

  it("the owner can reject", async () => {
    const { app, pay, holds, custody, tokenOf } = await harness();
    const { verdictId } = (await pay()).json();
    const response = await approve(app, verdictId, { action: "reject", ownerToken: tokenOf(holds[0]) });
    expect(response.json().execution).toMatchObject({ status: "refused", note: "You rejected this payment." });
    expect(custody.transfers).toEqual([]);
  });

  // The attack this whole flow exists to stop: a hijacked agent approving its own payment.
  it.each<[string, string]>([
    ["the agent's own credential", AGENT_TOKEN],
    ["the owner's API credential", OWNER_TOKEN],
    ["a made-up token", "f".repeat(64)],
  ])("%s can't approve", async (_name, ownerToken) => {
    const { app, pay, custody } = await harness();
    const { verdictId } = (await pay()).json();
    const response = await approve(app, verdictId, { action: "approve", ownerToken });
    expect(response.statusCode).toBe(401);
    expect(custody.transfers).toEqual([]);
  });

  it("nothing an agent can read reveals the token", async () => {
    const { app, pay, holds, tokenOf } = await harness();
    const { verdictId } = (await pay()).json();
    const token = tokenOf(holds[0]);
    for (const url of [`/v1/verdicts/${verdictId}`, "/v1/verdicts", "/v1/stats", "/v1/policy", "/v1/audit", "/health"]) {
      const response = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).not.toContain(token);
    }
  });

  it.each<[string, Record<string, unknown>]>([
    ["no token", { action: "approve" }],
    ["no action", { ownerToken: "x" }],
    ["an unknown action", { action: "maybe", ownerToken: "x" }],
    ["an extra field", { action: "approve", ownerToken: "x", force: true }],
  ])("refuses a body with %s", async (_name, payload) => {
    const { app, pay } = await harness();
    const { verdictId } = (await pay()).json();
    expect((await approve(app, verdictId, payload)).statusCode).toBe(400);
  });

  it("refuses an id that isn't a uuid, and an unknown one", async () => {
    const { app } = await harness();
    expect((await approve(app, "not-a-uuid", { action: "approve", ownerToken: "x" })).statusCode).toBe(400);
    expect((await approve(app, crypto.randomUUID(), { action: "approve", ownerToken: "x" })).statusCode).toBe(404);
  });

  it("is rate limited against guessing", async () => {
    const { app } = await harness();
    const id = crypto.randomUUID();
    let last = 0;
    for (let attempt = 0; attempt < 31; attempt += 1) last = (await approve(app, id, { action: "approve", ownerToken: "x" })).statusCode;
    expect(last).toBe(429);
  });
});

describe("freeze and unfreeze", () => {
  const post = (app: FastifyInstance, url: string, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, headers });

  it("an agent can't unfreeze, or freeze", async () => {
    const { app, agent, service } = await harness();
    service.freeze();
    expect((await post(app, "/v1/unfreeze", agent)).statusCode).toBe(401);
    expect(service.isFrozen()).toBe(true);
    service.unfreeze();
    expect((await post(app, "/v1/freeze", agent)).statusCode).toBe(401);
    expect(service.isFrozen()).toBe(false);
  });

  it("the owner freezes everything, then unfreezes", async () => {
    const { app, owner, pay, makeKnown, custody } = await harness();
    makeKnown();
    expect((await post(app, "/v1/freeze", owner)).json()).toEqual({ frozen: true });
    expect((await pay()).json()).toMatchObject({ decision: "BLOCK", execution: { status: "refused" } });
    expect(custody.transfers).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/health" })).json().frozen).toBe(true);
    expect((await post(app, "/v1/unfreeze", owner)).json()).toEqual({ frozen: false });
    expect((await pay()).json().execution.status).toBe("executed");
  });

  it("an approval during a freeze is a 409, and nothing moves", async () => {
    const { app, owner, pay, holds, custody, tokenOf } = await harness();
    const { verdictId } = (await pay()).json();
    await post(app, "/v1/freeze", owner);
    const response = await app.inject({ method: "POST", url: `/v1/approve/${verdictId}`, payload: { action: "approve", ownerToken: tokenOf(holds[0]) } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("frozen");
    expect(custody.transfers).toEqual([]);
  });
});

describe("owner views", () => {
  it("pending approvals need the owner credential, and carry no token", async () => {
    const { app, pay, owner, agent, holds, tokenOf } = await harness();
    await pay();
    expect((await app.inject({ method: "GET", url: "/v1/approvals" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/approvals", headers: agent })).statusCode).toBe(401);
    const response = await app.inject({ method: "GET", url: "/v1/approvals", headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
    expect(response.json().approvals).toHaveLength(1);
    expect(response.body).not.toContain(tokenOf(holds[0]));
  });

  it("the owner can get a fresh link; an agent can't", async () => {
    const { app, pay, owner, agent } = await harness();
    const { verdictId } = (await pay()).json();
    expect((await app.inject({ method: "POST", url: `/v1/approvals/${verdictId}/link`, headers: agent })).statusCode).toBe(401);
    const response = await app.inject({ method: "POST", url: `/v1/approvals/${verdictId}/link`, headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
    expect(response.json().approvalUrl).toContain(`/approve/${verdictId}?token=`);
  });
});

describe("reads", () => {
  it("lists verdicts, most recent first, up to the limit", async () => {
    const { app, pay, body } = await harness();
    const first = (await pay(body({ payee: "first-payee.near" }))).json();
    const second = (await pay(body({ payee: "second-payee.near" }))).json();
    const all = (await app.inject({ method: "GET", url: "/v1/verdicts", headers: { authorization: `Bearer ${OWNER_TOKEN}` } })).json().verdicts;
    expect(all.map((verdict: { verdictId: string }) => verdict.verdictId)).toEqual([second.verdictId, first.verdictId]);
    expect((await app.inject({ method: "GET", url: "/v1/verdicts?limit=1", headers: { authorization: `Bearer ${OWNER_TOKEN}` } })).json().verdicts).toHaveLength(1);
  });

  it.each(["0", "-1", "9999", "abc"])("refuses limit=%s", async (limit) => {
    const { app } = await harness();
    expect((await app.inject({ method: "GET", url: `/v1/verdicts?limit=${limit}`, headers: { authorization: `Bearer ${OWNER_TOKEN}` } })).statusCode).toBe(400);
  });

  it("gets one verdict, 404s an unknown one, and 400s a bad id", async () => {
    const { app, pay } = await harness();
    const { verdictId } = (await pay()).json();
    expect((await app.inject({ method: "GET", url: `/v1/verdicts/${verdictId}`, headers: { authorization: `Bearer ${OWNER_TOKEN}` } })).json().verdictId).toBe(verdictId);
    expect((await app.inject({ method: "GET", url: `/v1/verdicts/${crypto.randomUUID()}`, headers: { authorization: `Bearer ${OWNER_TOKEN}` } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/verdicts/nope", headers: { authorization: `Bearer ${OWNER_TOKEN}` } })).statusCode).toBe(400);
  });

  it("verifies a signature, before and after execution", async () => {
    const { app, pay, makeKnown } = await harness();
    makeKnown();
    const { verdictId } = (await pay()).json();
    const response = await app.inject({ method: "GET", url: `/v1/verdicts/${verdictId}/verify` });
    expect(response.json()).toMatchObject({ valid: true, publicKey: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("says invalid when a stored verdict has been tampered with", async () => {
    const { app, pay, makeKnown, ledger } = await harness();
    makeKnown();
    const verdict = (await pay()).json();
    ledger.saveVerdict({ ...verdict, amount: "2000" });
    const response = await app.inject({ method: "GET", url: `/v1/verdicts/${verdict.verdictId}/verify` });
    expect(response.json().valid).toBe(false);
  });

  it("says invalid for a verdict signed with someone else's key, even a self-consistent one", async () => {
    const { app, pay, makeKnown, ledger } = await harness();
    makeKnown();
    const { signature: _signature, wardyPublicKey: _key, execution: _execution, agentId: _agentId, ...unsigned } = (await pay()).json();
    const forged = await signVerdict(unsigned, generateSigningKey());
    expect(await verifyVerdict(forged)).toBe(true);
    ledger.saveVerdict(forged);
    const response = await app.inject({ method: "GET", url: `/v1/verdicts/${forged.verdictId}/verify` });
    expect(response.json().valid).toBe(false);
  });

  it("a judge can verify what the API returned, with no help from the API", async () => {
    const { pay, makeKnown } = await harness();
    makeKnown();
    const fromTheWire = (await pay()).json();
    expect(fromTheWire.agentId).toBe("procure-bot");
    expect(await verifyVerdict(fromTheWire)).toBe(true);
    expect(await verifyVerdict({ ...fromTheWire, amount: "2000" })).toBe(false);
  });

  it("reports the policy and who can spend, with native transfers off", async () => {
    const { app } = await harness();
    const { policy, whoCanSpend, provider } = (await app.inject({ method: "GET", url: "/v1/policy", headers: { authorization: `Bearer ${OWNER_TOKEN}` } })).json();
    expect(whoCanSpend).toBe("Wardy Agent only");
    expect(provider).toBe("mock");
    expect(policy.nativeNearTransfers).toBe(false);
  });

  it("the network lookup says honestly when there's nothing", async () => {
    const { app } = await harness();
    expect((await app.inject({ method: "GET", url: "/v1/network/payee/near/acme-sh0p.near" })).json()).toMatchObject({ reported: false, reports: [] });
    expect((await app.inject({ method: "GET", url: "/v1/network/reports" })).json()).toEqual({ reports: [], anchor: null });
  });

  it("stats come from real verdicts, and earnings stay empty until something is earned", async () => {
    const { app, pay, body, makeKnown } = await harness();
    makeKnown();
    await pay();
    await pay(body({ payee: "acme-sh0p.near" }));
    expect((await app.inject({ method: "GET", url: "/v1/stats", headers: { authorization: `Bearer ${OWNER_TOKEN}` } })).json()).toMatchObject({
      checkedToday: 2,
      blockedToday: 1,
      paidToday: 1,
      saved: [{ asset: WNEAR_ASSET, amount: "2" }],
      earned: { checksSold: 0, revenue: [] },
    });
  });

  it("health answers", async () => {
    const { app } = await harness();
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok", mode: "offline", provider: "mock", frozen: false, demoTools: false });
  });
});

describe("for an agent", () => {
  it("given only the address, it can find out what this is", async () => {
    const { app } = await harness();
    const index = (await app.inject({ method: "GET", url: "/" })).json();
    expect(index.forAgents).toBe("/llms.txt");
    const text = await app.inject({ method: "GET", url: "/llms.txt" });
    expect(text.statusCode).toBe(200);
    expect(text.headers["content-type"]).toContain("text/plain");
    for (const needle of ["/v1/pay", "/v1/check", "nextStep", "wait_for_owner", "wNEAR"]) expect(text.body).toContain(needle);
  });

  it("every answer carries a next step it can act on", async () => {
    const { pay, body, makeKnown, app } = await harness();
    expect((await pay(body({ payee: "first-time-payee.near" }))).json().nextStep).toBe("stop"); // Doesn't exist, so it's blocked.
    expect((await pay()).json().nextStep).toBe("wait_for_owner");
    makeKnown();
    expect((await pay(body({ amount: "1.5" }))).json().nextStep).toBe("done");
    const check = await app.inject({ method: "POST", url: "/v1/check", headers: { authorization: `Bearer ${AGENT_TOKEN}` }, payload: body({ requestId: crypto.randomUUID(), payee: "no-such-account.near" }) });
    expect(check.json().nextStep).toBe("do_not_pay");
  });

  it("a mistake says what to fix, and doesn't repeat what was sent", async () => {
    const { pay, body } = await harness();
    const response = await pay(body({ amount: "SECRET-WORDS" }));
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("amount");
    expect(response.json().message).toContain("decimal");
    expect(response.body).not.toContain("SECRET-WORDS");
  });

  it("too many requests says to wait, instead of a code", async () => {
    const { app, body } = await harness({ checkRateLimitPerMinute: 1 });
    await app.inject({ method: "POST", url: "/v1/check", payload: body({ ownerId: "someone-else.near" }) });
    const second = await app.inject({ method: "POST", url: "/v1/check", payload: body({ ownerId: "someone-else.near", requestId: crypto.randomUUID() }) });
    expect(second.statusCode).toBe(429);
    expect(second.json().message).toContain("Wait a minute");
  });

  describe("GET /v1/pay/:id/status: what happened to my payment", () => {
    const status = (app: FastifyInstance, id: string, token = AGENT_TOKEN) => app.inject({ method: "GET", url: `/v1/pay/${id}/status`, headers: { authorization: `Bearer ${token}` } });

    it("while the owner decides, it says wait, and until when", async () => {
      const { app, pay } = await harness();
      const { verdictId } = (await pay()).json();
      expect((await status(app, verdictId)).json()).toMatchObject({ decision: "HOLD", paid: false, status: "pending_owner", nextStep: "wait_for_owner" });
      expect((await status(app, verdictId)).json().decideBy).toBeTruthy();
    });

    it("after a rejection, it says stop", async () => {
      const { app, pay, holds, tokenOf } = await harness();
      const { verdictId } = (await pay()).json();
      await app.inject({ method: "POST", url: `/v1/approve/${verdictId}`, payload: { action: "reject", ownerToken: tokenOf(holds[0]) } });
      expect((await status(app, verdictId)).json()).toMatchObject({ paid: false, status: "refused", nextStep: "stop" });
    });

    it("after an approval, it says done, with the transaction", async () => {
      const { app, pay, holds, tokenOf } = await harness();
      const { verdictId } = (await pay()).json();
      await app.inject({ method: "POST", url: `/v1/approve/${verdictId}`, payload: { action: "approve", ownerToken: tokenOf(holds[0]) } });
      const answer = (await status(app, verdictId)).json();
      expect(answer).toMatchObject({ paid: true, status: "executed", nextStep: "done" });
      expect(answer.txHash).toBeTruthy();
    });

    it("says nothing about the owner: no reasons, signals, amount, history or token", async () => {
      const { app, pay, holds, tokenOf } = await harness();
      const { verdictId } = (await pay()).json();
      const response = await status(app, verdictId);
      expect(Object.keys(response.json()).sort()).toEqual(["decideBy", "decision", "nextStep", "paid", "status", "verdictId"]);
      expect(response.body).not.toContain(tokenOf(holds[0]));
    });

    it("needs a credential, and the owner's works too", async () => {
      const { app, pay } = await harness();
      const { verdictId } = (await pay()).json();
      expect((await app.inject({ method: "GET", url: `/v1/pay/${verdictId}/status` })).statusCode).toBe(401);
      expect((await status(app, verdictId, "wrong")).statusCode).toBe(401);
      expect((await status(app, verdictId, OWNER_TOKEN)).statusCode).toBe(200);
    });

    it("an unknown payment is a 404, a bad id a 400, and a check isn't a payment", async () => {
      const { app, body } = await harness();
      expect((await status(app, crypto.randomUUID())).statusCode).toBe(404);
      expect((await status(app, "nope")).statusCode).toBe(400);
      const check = (await app.inject({ method: "POST", url: "/v1/check", headers: { authorization: `Bearer ${AGENT_TOKEN}` }, payload: body() })).json();
      expect((await status(app, check.verdictId)).statusCode).toBe(404);
    });
  });
});

describe("who can read what", () => {
  const PRIVATE = ["/v1/verdicts", "/v1/stats", "/v1/policy", "/v1/stream", "/v1/audit", "/v1/approvals"];

  it.each(PRIVATE)("%s needs the owner's credential: nothing else gets the owner's history or limits", async (url) => {
    const { app } = await harness();
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${AGENT_TOKEN}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url, headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
  });

  it("a single verdict needs it too, but checking its signature doesn't, and says nothing about the payment", async () => {
    const { app, pay } = await harness();
    const { verdictId } = (await pay()).json();
    expect((await app.inject({ method: "GET", url: `/v1/verdicts/${verdictId}` })).statusCode).toBe(401);
    const verify = await app.inject({ method: "GET", url: `/v1/verdicts/${verdictId}/verify` });
    expect(verify.statusCode).toBe(200);
    expect(Object.keys(verify.json()).sort()).toEqual(["publicKey", "valid"]);
  });

  it("the Wardy Network and health stay public", async () => {
    const { app } = await harness();
    for (const url of ["/v1/network/reports", "/v1/network/payee/near/x.near", "/health"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(200);
    }
  });

  it("the agent's credential can't publish or withdraw a report", async () => {
    const { app, pay } = await harness();
    const { verdictId } = (await pay()).json();
    const headers = { authorization: `Bearer ${AGENT_TOKEN}` };
    expect((await app.inject({ method: "POST", url: `/v1/verdicts/${verdictId}/report`, headers })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/network/reports/x/revoke", headers })).statusCode).toBe(401);
  });
});

describe("the owner's phone: POST /v1/approve/:id/preview", () => {
  const preview = (app: FastifyInstance, id: string, ownerToken: string) => app.inject({ method: "POST", url: `/v1/approve/${id}/preview`, payload: { ownerToken } });
  const approve = (app: FastifyInstance, id: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/v1/approve/${id}`, payload });

  it("shows what's waiting, using only the link's token, and doesn't spend it", async () => {
    const { app, pay, holds, tokenOf, custody } = await harness();
    const { verdictId } = (await pay()).json();
    const token = tokenOf(holds[0]);
    const first = (await preview(app, verdictId, token)).json();
    expect(first).toMatchObject({ open: true, verdict: { verdictId, decision: "HOLD", execution: { status: "pending_owner" } } });
    expect(first.expiresAt).toBeTruthy();
    expect(custody.transfers).toEqual([]);
    expect((await approve(app, verdictId, { action: "reject", ownerToken: token })).statusCode).toBe(200);
  });

  it("after deciding, a reload shows the result and isn't open any more", async () => {
    const { app, pay, holds, tokenOf } = await harness();
    const { verdictId } = (await pay()).json();
    const token = tokenOf(holds[0]);
    await approve(app, verdictId, { action: "reject", ownerToken: token });
    expect((await preview(app, verdictId, token)).json()).toMatchObject({ open: false, verdict: { execution: { status: "refused" } } });
  });

  it.each<[string, string]>([["a wrong token", "not-the-token"], ["the owner's own credential", OWNER_TOKEN], ["the agent's credential", AGENT_TOKEN]])("refuses %s", async (_name, ownerToken) => {
    const { app, pay } = await harness();
    const { verdictId } = (await pay()).json();
    const response = await preview(app, verdictId, ownerToken);
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain("amount");
  });

  it("a token for one payment can't read another", async () => {
    const { app, pay, body, holds, tokenOf } = await harness();
    await pay();
    const other = (await pay(body({ amount: "1.5" }))).json();
    expect(other.decision).toBe("HOLD");
    expect((await preview(app, other.verdictId, tokenOf(holds[0]))).statusCode).toBe(401);
  });

  it("an unknown payment looks the same as a wrong token, so ids can't be probed", async () => {
    const { app } = await harness();
    const response = await preview(app, crypto.randomUUID(), "anything");
    expect(response.statusCode).toBe(401);
  });

  it("an old link stops working once a fresh one is made", async () => {
    const { app, pay, holds, tokenOf } = await harness();
    const { verdictId } = (await pay()).json();
    const old = tokenOf(holds[0]);
    const renewed = await app.inject({ method: "POST", url: `/v1/approvals/${verdictId}/link`, headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
    expect(renewed.statusCode).toBe(200);
    expect((await preview(app, verdictId, old)).statusCode).toBe(401);
  });

  it("refuses an extra field", async () => {
    const { app, pay, holds, tokenOf } = await harness();
    const { verdictId } = (await pay()).json();
    const response = await app.inject({ method: "POST", url: `/v1/approve/${verdictId}/preview`, payload: { ownerToken: tokenOf(holds[0]), force: true } });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /v1/audit", () => {
  it("checks the chain, and can narrow to one verdict", async () => {
    const { app, pay, body, makeKnown } = await harness();
    makeKnown();
    const { verdictId } = (await pay()).json();
    await pay(body({ payee: "acme-sh0p.near" }));
    const headers = { authorization: `Bearer ${OWNER_TOKEN}` };
    const all = (await app.inject({ method: "GET", url: "/v1/audit", headers })).json();
    expect(all.valid).toBe(true);
    expect(all.signaturesChecked).toBeGreaterThan(0);
    expect(all.records.length).toBeGreaterThan(2);
    const one = (await app.inject({ method: "GET", url: `/v1/audit?verdictId=${verdictId}`, headers })).json();
    expect(one.valid).toBe(true);
    expect(one.records.length).toBeGreaterThan(0);
    for (const { entry } of one.records) expect(entry.verdictId ?? entry.verdict.verdictId).toBe(verdictId);
  });

  it("refuses a bad id", async () => {
    const { app } = await harness();
    expect((await app.inject({ method: "GET", url: "/v1/audit?verdictId=nope", headers: { authorization: `Bearer ${OWNER_TOKEN}` } })).statusCode).toBe(400);
  });
});

describe("demo tools", () => {
  const OWNER_HEADERS = { authorization: `Bearer ${OWNER_TOKEN}` };

  it("don't exist unless they're switched on", async () => {
    const { app } = await harness();
    expect((await app.inject({ method: "POST", url: "/v1/demo/traffic", headers: OWNER_HEADERS })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/v1/lab/run", headers: OWNER_HEADERS })).statusCode).toBe(404);
  });

  function tools(overrides: Partial<DemoTools> = {}): DemoTools {
    return { playTraffic: async () => {}, runLab: async () => {}, labVerdict: () => undefined, ...overrides };
  }

  it("need the owner's credential, and health says they're there", async () => {
    const { app } = await harness({ demo: tools() });
    expect((await app.inject({ method: "GET", url: "/health" })).json().demoTools).toBe(true);
    for (const url of ["/v1/demo/traffic", "/v1/lab/run"]) {
      expect((await app.inject({ method: "POST", url })).statusCode, url).toBe(401);
      expect((await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${AGENT_TOKEN}` } })).statusCode, url).toBe(401);
    }
  });

  it("traffic starts once at a time", async () => {
    let finish = () => {};
    const { app } = await harness({ demo: tools({ playTraffic: () => new Promise<void>((resolve) => { finish = resolve; }) }) });
    expect((await app.inject({ method: "POST", url: "/v1/demo/traffic", headers: OWNER_HEADERS })).statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: "/v1/demo/traffic", headers: OWNER_HEADERS })).statusCode).toBe(409);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await app.inject({ method: "POST", url: "/v1/demo/traffic", headers: OWNER_HEADERS })).statusCode).toBe(202);
  });

  it("the lab streams each event as it happens", async () => {
    const { app } = await harness({
      demo: tools({ runLab: async (send) => { send("scenario", { id: "A1" }); send("done", { ok: true }); } }),
    });
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const text = await (await fetch(`${url}/v1/lab/run`, { method: "POST", headers: OWNER_HEADERS })).text();
    expect(text).toContain('event: scenario\ndata: {"id":"A1"}');
    expect(text).toContain("event: done");
  });

  it("a lab failure says so, in plain words, without details", async () => {
    const { app } = await harness({ demo: tools({ runLab: async () => { throw new Error("secret detail"); } }) });
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const text = await (await fetch(`${url}/v1/lab/run`, { method: "POST", headers: OWNER_HEADERS })).text();
    expect(text).toContain("event: error");
    expect(text).not.toContain("secret detail");
  });

  it("a verdict from the lab can be read and verified, but not reported", async () => {
    const key = generateSigningKey();
    const signed = await signVerdict(
      { verdictId: crypto.randomUUID(), requestId: crypto.randomUUID(), mode: "pay", requestHash: "a".repeat(64), payee: "x.near", chain: "near", asset: "a", amount: "1", decision: "BLOCK", riskScore: 100, signals: [], reasons: [], createdAt: new Date().toISOString() },
      key,
    );
    const { app } = await harness({ demo: tools({ labVerdict: (id) => (id === signed.verdictId ? signed : undefined) }) });
    expect((await app.inject({ method: "GET", url: `/v1/verdicts/${signed.verdictId}`, headers: OWNER_HEADERS })).json().payee).toBe("x.near");
    expect((await app.inject({ method: "POST", url: `/v1/verdicts/${signed.verdictId}/report`, headers: OWNER_HEADERS })).statusCode).toBe(404);
  });
});

describe("CORS", () => {
  it("allows the dashboard's origin and no other", async () => {
    const { app } = await harness();
    const from = (origin: string) => app.inject({ method: "GET", url: "/health", headers: { origin } });
    expect((await from("http://localhost:5173")).headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect((await from("https://evil.test")).headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("GET /v1/stream", () => {
  async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string) {
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 5000;
    while (!text.includes(marker) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    return text;
  }

  it("streams verdicts live, carries no token, and stops cleanly", async () => {
    const { app, pay, holds, service, tokenOf } = await harness();
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${url}/v1/stream`, { signal: controller.signal, headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await readUntil(reader, "connected");
    const before = service.listenerCount("verdict");

    await pay();
    const text = await readUntil(reader, "pending_owner");
    expect(text).toContain("event: verdict");
    expect(text).toContain('"decision":"HOLD"');
    expect(text).not.toContain(tokenOf(holds[0]));

    controller.abort();
    await reader.cancel().catch(() => undefined);
    for (let attempt = 0; attempt < 50 && service.listenerCount("verdict") >= before; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(service.listenerCount("verdict")).toBe(before - 1);
  });
});
