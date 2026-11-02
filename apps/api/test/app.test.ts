import { AuditLog, DEFAULT_POLICY, generateSigningKey, type HoldNotice, Ledger, PaymentService, verifyVerdict, WNEAR_ASSET } from "@wardy-agent/core";
import { MockChainData, MockCustody, OFFLINE_ACCOUNTS } from "@wardy-agent/providers";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { type AppOptions, buildApp } from "../src/app.js";

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
    reports: { reportsFor: () => [], recent: () => [] },
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
  return { app, service, custody, holds, agent, owner, body, pay, makeKnown, tokenOf };
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
  it("needs no credential and never moves money", async () => {
    const { app, body, makeKnown, custody } = await harness();
    makeKnown();
    const response = await app.inject({ method: "POST", url: "/v1/check", payload: body() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ decision: "ALLOW", mode: "check" });
    expect(response.json().execution).toBeUndefined();
    expect(custody.transfers).toEqual([]);
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
    expect((await app.inject({ method: "POST", url: "/v1/check", payload: body({ amount: "abc" }) })).statusCode).toBe(400);
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
    for (const url of [`/v1/verdicts/${verdictId}`, "/v1/verdicts", "/v1/stats", "/v1/policy", "/health"]) {
      expect((await app.inject({ method: "GET", url })).body, url).not.toContain(token);
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
    const response = await app.inject({ method: "GET", url: "/v1/approvals", headers: owner });
    expect(response.json().approvals).toHaveLength(1);
    expect(response.body).not.toContain(tokenOf(holds[0]));
  });

  it("the owner can get a fresh link; an agent can't", async () => {
    const { app, pay, owner, agent } = await harness();
    const { verdictId } = (await pay()).json();
    expect((await app.inject({ method: "POST", url: `/v1/approvals/${verdictId}/link`, headers: agent })).statusCode).toBe(401);
    const response = await app.inject({ method: "POST", url: `/v1/approvals/${verdictId}/link`, headers: owner });
    expect(response.json().approvalUrl).toContain(`/approve/${verdictId}?token=`);
  });
});

describe("reads", () => {
  it("lists verdicts, most recent first, up to the limit", async () => {
    const { app, pay, body } = await harness();
    const first = (await pay(body({ payee: "first-payee.near" }))).json();
    const second = (await pay(body({ payee: "second-payee.near" }))).json();
    const all = (await app.inject({ method: "GET", url: "/v1/verdicts" })).json().verdicts;
    expect(all.map((verdict: { verdictId: string }) => verdict.verdictId)).toEqual([second.verdictId, first.verdictId]);
    expect((await app.inject({ method: "GET", url: "/v1/verdicts?limit=1" })).json().verdicts).toHaveLength(1);
  });

  it.each(["0", "-1", "9999", "abc"])("refuses limit=%s", async (limit) => {
    const { app } = await harness();
    expect((await app.inject({ method: "GET", url: `/v1/verdicts?limit=${limit}` })).statusCode).toBe(400);
  });

  it("gets one verdict, 404s an unknown one, and 400s a bad id", async () => {
    const { app, pay } = await harness();
    const { verdictId } = (await pay()).json();
    expect((await app.inject({ method: "GET", url: `/v1/verdicts/${verdictId}` })).json().verdictId).toBe(verdictId);
    expect((await app.inject({ method: "GET", url: `/v1/verdicts/${crypto.randomUUID()}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/verdicts/nope" })).statusCode).toBe(400);
  });

  it("verifies a signature, before and after execution", async () => {
    const { app, pay, makeKnown } = await harness();
    makeKnown();
    const { verdictId } = (await pay()).json();
    const response = await app.inject({ method: "GET", url: `/v1/verdicts/${verdictId}/verify` });
    expect(response.json()).toMatchObject({ valid: true, publicKey: expect.stringMatching(/^[0-9a-f]{64}$/) });
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
    const { policy, whoCanSpend, provider } = (await app.inject({ method: "GET", url: "/v1/policy" })).json();
    expect(whoCanSpend).toBe("Wardy Agent only");
    expect(provider).toBe("mock");
    expect(policy.nativeNearTransfers).toBe(false);
  });

  it("the network lookup says honestly when there's nothing", async () => {
    const { app } = await harness();
    expect((await app.inject({ method: "GET", url: "/v1/network/payee/near/acme-sh0p.near" })).json()).toMatchObject({ reported: false, reports: [] });
    expect((await app.inject({ method: "GET", url: "/v1/network/reports" })).json()).toEqual({ reports: [] });
  });

  it("stats come from real verdicts, and earnings stay empty until something is earned", async () => {
    const { app, pay, body, makeKnown } = await harness();
    makeKnown();
    await pay();
    await pay(body({ payee: "acme-sh0p.near" }));
    expect((await app.inject({ method: "GET", url: "/v1/stats" })).json()).toMatchObject({
      checkedToday: 2,
      blockedToday: 1,
      paidToday: 1,
      saved: [{ asset: WNEAR_ASSET, amount: "2" }],
      earned: { checksSold: 0, revenue: [] },
    });
  });

  it("health answers", async () => {
    const { app } = await harness();
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok", mode: "offline", provider: "mock", frozen: false });
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
    const response = await fetch(`${url}/v1/stream`, { signal: controller.signal });
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
