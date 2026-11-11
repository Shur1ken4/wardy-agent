// Signed-in owners on the hosted server: each gets a testnet agent of their own, with small limits, and nothing of one
// owner's reaches another. The wallet is played by near-api-js's NEP-413 signer; NEAR and custody are stand-ins.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSigningKey } from "@wardy-agent/core";
import { MockChainData, MockCustody } from "@wardy-agent/providers";
import { base64 } from "@scure/base";
import { KeyPair, KeyPairSigner } from "near-api-js";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_SESSIONS_PER_ACCOUNT, SIGN_IN_MESSAGE, WalletSignIn } from "../auth.js";
import { DailyCappedAnalyzer, type HostedOwners, ownerKey, PoolDailyCap, testnetPayeeProblem } from "../hosted.js";
import { buildHostedApp } from "../serve.js";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "wardy-agent-owners-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fullAccess = (async () => new Response(JSON.stringify({ result: { permission: "FullAccess" } }))) as unknown as typeof fetch;
const SHOP = "wardy-agent-shop.testnet";

function owners(custody = new MockCustody({ "nep141:wrap.near": "10" })): HostedOwners {
  return {
    signIn: new WalletSignIn({ recipient: "wardy.example", fetchFn: fullAccess }),
    custody,
    env: { WARDY_SIGNING_KEY: generateSigningKey() },
    chainData: new MockChainData({ [SHOP]: { ageHours: 24 * 400, txCount: 300 } }),
  };
}

async function server(dataRoot = temp(), withOwners = owners(), signUpsPerAddressPerDay = 100) {
  const { app, tenancy } = await buildHostedApp({ dataRoot, webUrl: "https://wardy.example", indexHtml: "<!doctype html>", dist: temp(), owners: withOwners, signUpsPerAddressPerDay });
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const signIn = async (accountId: string) => {
    const keyPair = KeyPair.fromRandom("ed25519");
    const { nonce, recipient, message } = (await app.inject({ method: "POST", url: "/v1/auth/challenge" })).json();
    expect(message).toBe(SIGN_IN_MESSAGE);
    const signed = await new KeyPairSigner(keyPair).signNep413Message(accountId, { message, recipient, nonce: base64.decode(nonce) });
    const answer = await app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { accountId, publicKey: keyPair.getPublicKey().toString(), signature: base64.encode(signed.signature), nonce },
    });
    expect(answer.statusCode).toBe(200);
    const { sessionToken } = answer.json() as { sessionToken: string };
    const { agentToken } = (await app.inject({ method: "POST", url: "/v1/agent-token", headers: as(sessionToken) })).json() as { agentToken: string };
    return { sessionToken, agentToken };
  };
  const pay = (agentToken: string, ownerId: string, overrides: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: "/v1/pay",
      headers: as(agentToken),
      payload: { requestId: crypto.randomUUID(), agentId: "bot", ownerId, payee: SHOP, asset: "wNEAR", amount: "0.005", purpose: "test", createdAt: new Date().toISOString(), ...overrides },
    });
  return { app, tenancy, as, signIn, pay };
}

describe("signed-in owners", () => {
  it("get a testnet agent of their own, with the hosted limits", async () => {
    const { app, as, signIn } = await server();
    const alice = await signIn("alice.near");
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: as(alice.sessionToken) })).json()).toMatchObject({ kind: "owner", ownerId: "alice.near" });
    expect((await app.inject({ method: "GET", url: "/health", headers: as(alice.sessionToken) })).json()).toMatchObject({ mode: "testnet", demoTools: false });
    const { policy, ownerId } = (await app.inject({ method: "GET", url: "/v1/policy", headers: as(alice.sessionToken) })).json();
    expect(ownerId).toBe("alice.near");
    expect(policy).toMatchObject({ maxPerPayment: "0.02", dailyBudget: "0.1", allowedAssets: ["nep141:wrap.near"] });
  });

  it("are kept apart: one owner's agent can't pay as another, and neither sees the other's payments", async () => {
    const { app, as, signIn, pay } = await server();
    const alice = await signIn("alice.near");
    const bob = await signIn("bob.near");
    expect((await pay(alice.agentToken, "bob.near")).statusCode).toBe(403);
    const paid = (await pay(alice.agentToken, "alice.near")).json();
    expect(["HOLD", "ALLOW"]).toContain(paid.decision);
    const bobSees = (await app.inject({ method: "GET", url: "/v1/verdicts", headers: as(bob.sessionToken) })).json().verdicts;
    expect(bobSees).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/v1/verdicts/${paid.verdictId}`, headers: as(bob.sessionToken) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/verdicts", headers: as(alice.agentToken) })).statusCode).toBe(401);
  });

  it("pay only testnet accounts, so nothing here can name a real mainnet account", async () => {
    const { signIn, pay } = await server();
    const alice = await signIn("alice.near");
    const refused = await pay(alice.agentToken, "alice.near", { payee: "shop.near" });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe("payee_not_allowed");
    expect(testnetPayeeProblem("a".repeat(64))).toBeUndefined();
    expect(testnetPayeeProblem("x.testnet")).toBeUndefined();
    expect(testnetPayeeProblem("x.near")).toMatch(/testnet only/);
  });

  it("are held to the small limits, and the owner's approval pays through the shared wallet", async () => {
    const custody = new MockCustody({ "nep141:wrap.near": "10" });
    const { tenancy, signIn, pay, app } = await server(temp(), owners(custody));
    const alice = await signIn("alice.near");
    expect((await pay(alice.agentToken, "alice.near", { amount: "0.5" })).json().decision).toBe("BLOCK");
    let link = "";
    tenancy.forOwner(alice.sessionToken)?.service.on("hold", (hold) => {
      link = hold.approvalUrl;
    });
    const held = (await pay(alice.agentToken, "alice.near", { amount: "0.015" })).json();
    expect(held.decision).toBe("HOLD");
    const params = new URLSearchParams(new URL(link).hash.slice(1));
    expect(params.get("t")).toBe(ownerKey("alice.near"));
    const approved = await app.inject({ method: "POST", url: `/v1/approve/${held.verdictId}`, payload: { action: "approve", ownerToken: params.get("token"), tenant: params.get("t") } });
    expect(approved.json().execution.status).toBe("executed");
    expect(custody.transfers.map((transfer) => transfer.amount)).toEqual(["0.015"]);
    const stats = (await app.inject({ method: "GET", url: "/v1/stats", headers: { authorization: `Bearer ${alice.sessionToken}` } })).json();
    expect(stats.spentLast24h).toEqual([{ asset: "nep141:wrap.near", amount: "0.015" }]);
  });

  it("keep their agent and history after a restart, but must sign in again", async () => {
    const dataRoot = temp();
    const shared = owners();
    const first = await server(dataRoot, shared);
    const alice = await first.signIn("alice.near");
    const paid = (await first.pay(alice.agentToken, "alice.near")).json();
    await first.app.close();

    const restarted = await server(dataRoot, { ...shared, signIn: new WalletSignIn({ recipient: "wardy.example", fetchFn: fullAccess }) });
    expect(restarted.tenancy.ownerCount).toBe(1);
    expect((await restarted.app.inject({ method: "GET", url: "/v1/verdicts", headers: restarted.as(alice.sessionToken) })).statusCode).toBe(401);
    const again = (await restarted.pay(alice.agentToken, "alice.near")).json();
    expect(again.verdictId).not.toBe(paid.verdictId);
    expect((await restarted.app.inject({ method: "GET", url: `/v1/pay/${paid.verdictId}/status`, headers: restarted.as(alice.agentToken) })).statusCode).toBe(200);
  });

  it("stop being signed in on sign-out, and a new agent token retires the old one", async () => {
    const { app, as, signIn, pay } = await server();
    const alice = await signIn("alice.near");
    const { agentToken } = (await app.inject({ method: "POST", url: "/v1/agent-token", headers: as(alice.sessionToken) })).json();
    expect((await pay(alice.agentToken, "alice.near")).statusCode).toBe(401);
    expect((await pay(agentToken, "alice.near")).statusCode).toBe(200);
    await app.inject({ method: "POST", url: "/v1/auth/logout", headers: as(alice.sessionToken) });
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: as(alice.sessionToken) })).statusCode).toBe(401);
  });

  it("see their account: since when, their agent's token and last call, and what they spent, never a token itself", async () => {
    const { app, as, signIn, pay } = await server();
    const alice = await signIn("alice.near");
    const me = async () => (await app.inject({ method: "GET", url: "/v1/me", headers: as(alice.sessionToken) })).json();
    const before = await me();
    expect(before.signedUpAt).toMatch(/^\d{4}-/);
    expect(before.agent.tokenMadeAt).toMatch(/^\d{4}-/);
    expect(before.agent.lastSeenAt).toBeUndefined();

    const paid = (await pay(alice.agentToken, "alice.near", { amount: "0.005" })).json();
    const after = await me();
    expect(after.agent.lastSeenAt).toMatch(/^\d{4}-/);
    const shown = JSON.stringify(after);
    expect(shown).not.toContain(alice.agentToken);
    expect(shown).not.toContain(alice.sessionToken);
    expect(Object.keys(after).sort()).toEqual(["agent", "kind", "ownerId", "signInAvailable", "signedUpAt"]);

    const stats = (await app.inject({ method: "GET", url: "/v1/stats", headers: as(alice.sessionToken) })).json();
    const settled = paid.execution?.status === "executed" ? [{ asset: "nep141:wrap.near", amount: "0.005" }] : [];
    expect(stats.spentLast24h).toEqual(settled);

    // A new token is a new agent: it hasn't called yet.
    await app.inject({ method: "POST", url: "/v1/agent-token", headers: as(alice.sessionToken) });
    expect((await me()).agent.lastSeenAt).toBeUndefined();
  });

  it("can't sign in with a bad signature, and the server says so without detail", async () => {
    const { app } = await server();
    const { nonce } = (await app.inject({ method: "POST", url: "/v1/auth/challenge" })).json();
    const keyPair = KeyPair.fromRandom("ed25519");
    const answer = await app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { accountId: "alice.near", publicKey: keyPair.getPublicKey().toString(), signature: base64.encode(new Uint8Array(64)), nonce },
    });
    expect(answer.statusCode).toBe(401);
    expect(answer.json().error).toBe("sign_in_failed");
  });

  it("can't fill the server with sign-ups", async () => {
    const { signIn, app } = await server(temp(), { ...owners(), maxOwners: 1 });
    await signIn("alice.near");
    const keyPair = KeyPair.fromRandom("ed25519");
    const { nonce, recipient, message } = (await app.inject({ method: "POST", url: "/v1/auth/challenge" })).json();
    const signed = await new KeyPairSigner(keyPair).signNep413Message("bob.near", { message, recipient, nonce: base64.decode(nonce) });
    const answer = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { accountId: "bob.near", publicKey: keyPair.getPublicKey().toString(), signature: base64.encode(signed.signature), nonce } });
    expect(answer.statusCode).toBe(503);
  });
});

describe("abuse of sign-in", () => {
  it("one address can make only a few new accounts a day, but anyone can sign back in", async () => {
    const { app, signIn } = await server(temp(), owners(), 2);
    await signIn("a1.testnet");
    await signIn("a2.testnet");
    await signIn("a1.testnet");
    const keyPair = KeyPair.fromRandom("ed25519");
    const { nonce, recipient, message } = (await app.inject({ method: "POST", url: "/v1/auth/challenge" })).json();
    const signed = await new KeyPairSigner(keyPair).signNep413Message("a3.testnet", { message, recipient, nonce: base64.decode(nonce) });
    const answer = await app.inject({ method: "POST", url: "/v1/auth/verify", payload: { accountId: "a3.testnet", publicKey: keyPair.getPublicKey().toString(), signature: base64.encode(signed.signature), nonce } });
    expect(answer.statusCode).toBe(503);
    expect(answer.json().message).toMatch(/Too many new accounts/);
  });

  it("an account keeps only its latest sessions, so signing in over and over can't fill memory", async () => {
    const signIn = new WalletSignIn({ recipient: "wardy.example", fetchFn: fullAccess });
    const keyPair = KeyPair.fromRandom("ed25519");
    const session = async () => {
      const { nonce, recipient, message } = signIn.challenge();
      const signed = await new KeyPairSigner(keyPair).signNep413Message("alice.near", { message, recipient, nonce: base64.decode(nonce) });
      return (await signIn.verify({ accountId: "alice.near", publicKey: keyPair.getPublicKey().toString(), signature: base64.encode(signed.signature), nonce })).sessionToken;
    };
    const first = await session();
    const second = await session();
    for (let i = 0; i < MAX_SESSIONS_PER_ACCOUNT - 1; i += 1) await session();
    expect(signIn.session(first)).toBeUndefined();
    expect(signIn.session(second)).toBe("alice.near");
  });
});

describe("the shared test wallet's daily cap", () => {
  it("refuses past the server's limit for the day, before anything is sent, and gives back a proven failure", async () => {
    let now = Date.parse("2026-11-09T10:00:00Z");
    const inner = new MockCustody({ "nep141:wrap.near": "10" });
    const pool = new PoolDailyCap(inner, "0.03", () => now);
    const send = (amount: string) => pool.transfer({ to: SHOP, asset: "nep141:wrap.near", amount, memo: "m", idempotencyKey: crypto.randomUUID() });
    expect((await send("0.02")).status).toBe("executed");
    const refused = await send("0.02");
    expect(refused).toMatchObject({ status: "failed", failureCode: "server_daily_limit" });
    expect(inner.transfers).toHaveLength(1);
    expect((await send("0.01")).status).toBe("executed");
    now += 24 * 60 * 60_000;
    expect((await send("0.02")).status).toBe("executed");
  });
});

describe("the private AI's daily cap", () => {
  it("reads only so many a day, then fails like an outage until the next day", async () => {
    let now = Date.parse("2026-11-06T10:00:00Z");
    const inner = { analyze: async () => ({ findings: [] }) as never };
    const capped = new DailyCappedAnalyzer(inner, 2, () => now);
    await capped.analyze("a");
    await capped.analyze("b");
    await expect(capped.analyze("c")).rejects.toThrow(/daily limit/);
    now += 24 * 60 * 60_000;
    await expect(capped.analyze("d")).resolves.toBeDefined();
  });
});

describe("one owner can't use up what's shared", () => {
  it("an owner's agent may make only so many requests a day, long before the disk minds", async () => {
    const { signIn, pay } = await server(temp(), { ...owners(), requestsPerOwnerPerDay: 3 });
    const alice = await signIn("alice.near");
    for (let i = 0; i < 3; i += 1) expect((await pay(alice.agentToken, "alice.near")).statusCode).toBe(200);
    const refused = await pay(alice.agentToken, "alice.near");
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error).toBe("daily_request_limit");
  });

  it("an owner's agent gets only a slice of the server's private AI reads", async () => {
    let reads = 0;
    const inner = { analyze: async () => { reads += 1; return { findings: null, attested: false }; } };
    const { signIn, pay } = await server(temp(), { ...owners(), analyzer: inner, aiPerOwnerPerDay: 2 });
    const alice = await signIn("alice.near");
    for (let i = 0; i < 4; i += 1) {
      const answer = await pay(alice.agentToken, "alice.near", { context: { invoiceText: "Invoice 42" } });
      expect(answer.statusCode).toBe(200);
    }
    expect(reads).toBe(2);
  });
});
