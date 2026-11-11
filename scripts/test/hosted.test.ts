// The hosted server, run in-process: visitors' sandboxes can't reach each other, and it won't hold a mainnet key.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostedTenancy } from "../hosted.js";
import { assertNoMainnetKeys, buildHostedApp, staticFile } from "../serve.js";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "wardy-agent-hosted-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function server() {
  const { app, tenancy } = await buildHostedApp({ dataRoot: temp(), webUrl: "https://wardy.example", indexHtml: "<!doctype html><title>dash</title>", dist: temp() });
  const sandbox = async () => (await app.inject({ method: "POST", url: "/v1/sandbox" })).json() as { key: string; ownerToken: string; agentToken: string };
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const pay = (agentToken: string, overrides: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: "/v1/pay",
      headers: as(agentToken),
      payload: { requestId: crypto.randomUUID(), agentId: "bot", ownerId: "demo-owner.near", payee: "acme-shop.near", asset: "wNEAR", amount: "1", purpose: "test", createdAt: new Date().toISOString(), ...overrides },
    });
  return { app, tenancy, sandbox, as, pay };
}

describe("sandboxes", () => {
  it("are separate: a freeze, a payment and its history stay with the visitor who made them", async () => {
    const { app, sandbox, as, pay } = await server();
    const one = await sandbox();
    const two = await sandbox();
    expect(one.ownerToken).not.toBe(two.ownerToken);

    await app.inject({ method: "POST", url: "/v1/freeze", headers: as(one.ownerToken) });
    expect((await app.inject({ method: "GET", url: "/health", headers: as(one.ownerToken) })).json().frozen).toBe(true);
    expect((await app.inject({ method: "GET", url: "/health", headers: as(two.ownerToken) })).json().frozen).toBe(false);

    const paid = (await pay(two.agentToken)).json();
    const twoSees = (await app.inject({ method: "GET", url: "/v1/verdicts", headers: as(two.ownerToken) })).json().verdicts.map((v: { verdictId: string }) => v.verdictId);
    const oneSees = (await app.inject({ method: "GET", url: "/v1/verdicts", headers: as(one.ownerToken) })).json().verdicts.map((v: { verdictId: string }) => v.verdictId);
    expect(twoSees).toContain(paid.verdictId);
    expect(oneSees).not.toContain(paid.verdictId);
    expect((await app.inject({ method: "GET", url: `/v1/verdicts/${paid.verdictId}`, headers: as(one.ownerToken) })).statusCode).toBe(404);
  });

  it("can't be opened with another visitor's agent token, or none", async () => {
    const { app, sandbox, as } = await server();
    const one = await sandbox();
    expect((await app.inject({ method: "GET", url: "/v1/verdicts" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/verdicts", headers: as(one.agentToken) })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/freeze", headers: as("made-up") })).statusCode).toBe(401);
  });

  it("send approval links that name their sandbox, and the token works only there", async () => {
    const { app, tenancy, sandbox, pay } = await server();
    const one = await sandbox();
    const two = await sandbox();
    let link = "";
    tenancy.forOwner(one.ownerToken)?.service.on("hold", (hold) => {
      link = hold.approvalUrl;
    });
    // Above the demo policy's "ask me above 3", to a payee it knows.
    const held = (await pay(one.agentToken, { amount: "4" })).json();
    expect(held.decision).toBe("HOLD");
    const params = new URLSearchParams(new URL(link).hash.slice(1));
    expect(params.get("t")).toBe(one.key);
    const token = params.get("token") as string;

    const wrongSandbox = await app.inject({ method: "POST", url: `/v1/approve/${held.verdictId}`, payload: { action: "reject", ownerToken: token, tenant: two.key } });
    expect(wrongSandbox.statusCode).not.toBe(200);
    const right = await app.inject({ method: "POST", url: `/v1/approve/${held.verdictId}`, payload: { action: "reject", ownerToken: token, tenant: one.key } });
    expect(right.statusCode).toBe(200);
    expect(right.json().execution.status).toBe("refused");
  });

  it("make room when full, and go when nobody has used them for a while, files and all", async () => {
    let now = 1_000;
    const dataRoot = temp();
    const tenancy = await HostedTenancy.create({ dataRoot, webUrl: "https://wardy.example", maxSandboxes: 2, sandboxIdleMs: 60_000, now: () => now });
    const first = await tenancy.createSandbox();
    now += 10;
    await tenancy.createSandbox();
    now += 10;
    await tenancy.createSandbox();
    expect(tenancy.sandboxCount).toBe(2);
    expect(tenancy.forOwner(first.ownerToken)).toBeUndefined();
    now += 120_000;
    tenancy.sweep();
    expect(tenancy.sandboxCount).toBe(0);
  });

  it("answers an agent with no credential from the public demo, never a visitor's sandbox", async () => {
    const { app, sandbox, as } = await server();
    const one = await sandbox();
    await app.inject({ method: "POST", url: "/v1/freeze", headers: as(one.ownerToken) });
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toMatchObject({ hosted: true, frozen: false });
    const check = await app.inject({
      method: "POST",
      url: "/v1/check",
      payload: { requestId: crypto.randomUUID(), agentId: "x", ownerId: "someone-else.near", payee: "acme-sh0p.near", asset: "wNEAR", amount: "1", purpose: "t", createdAt: new Date().toISOString() },
    });
    expect(check.json().decision).toBe("BLOCK");
  });
});

describe("the hosted server", () => {
  it("won't start with live mode or any mainnet setting", () => {
    expect(() => assertNoMainnetKeys({ WARDY_MODE: "live" })).toThrow(/live/);
    for (const name of ["NEAR_INTENTS_AGENT_API_KEY", "WARDY_GRANT_TOKEN", "WARDY_AGENT_ID", "AGENT_OWNER_PRIVATE_KEY"]) {
      expect(() => assertNoMainnetKeys({ [name]: "x" }), name).toThrow(name);
    }
    expect(() => assertNoMainnetKeys({ WARDY_MODE: "offline" })).not.toThrow();
  });

  it("won't sign with the key that signed real verdicts: it makes its own", () => {
    expect(() => assertNoMainnetKeys({ WARDY_SIGNING_KEY: "x" })).toThrow(/its own signing key/);
  });

  it("believes only its own proxy about who a visitor is, so a made-up X-Forwarded-For can't dodge a limit", async () => {
    const { app } = await server();
    const codes: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      // Each claims to be someone new. The proxy adds the real address last, which is the one that counts.
      const answer = await app.inject({ method: "POST", url: "/v1/sandbox", headers: { "x-forwarded-for": `10.0.0.${i}, 203.0.113.7` } });
      codes.push(answer.statusCode);
    }
    expect(codes.slice(0, 10).every((code) => code === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it("holds only a few live feeds open per visitor", async () => {
    const { app, sandbox, as } = await server();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { ownerToken } = await sandbox();
    const { port } = app.server.address() as { port: number };
    const controllers = Array.from({ length: 6 }, () => new AbortController());
    const statuses: number[] = [];
    for (const controller of controllers) {
      const answer = await fetch(`http://127.0.0.1:${port}/v1/stream`, { headers: as(ownerToken), signal: controller.signal });
      statuses.push(answer.status);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
    for (const controller of controllers) controller.abort();
    await app.close();
  });

  it("serves only files inside the dashboard's folder", () => {
    const root = temp();
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "assets", "app.js"), "ok");
    writeFileSync(join(root, "..", "secret.txt"), "no");
    expect(staticFile("/assets/app.js", root)).toBe(join(root, "assets", "app.js"));
    for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt", "/assets/", "/nope.js", "/%E0%A4%A", "/assets/app.js%00.png"]) {
      expect(staticFile(path, root), path).toBeUndefined();
    }
    rmSync(join(root, "..", "secret.txt"), { force: true });
  });

  it("answers a missing file with not found, and a page path with the dashboard", async () => {
    const { app } = await server();
    expect((await app.inject({ method: "GET", url: "/favicon.ico" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/no-such-page" })).body).toContain("<!doctype html>");
  });

  it("gives a browser the dashboard and an agent the JSON, with safety headers", async () => {
    const { app } = await server();
    const page = await app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } });
    expect(page.body).toContain("<title>dash</title>");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect((await app.inject({ method: "GET", url: "/" })).json().name).toBe("Wardy Agent");
    expect((await app.inject({ method: "GET", url: "/approve/abc" })).body).toContain("<title>dash</title>");
    expect((await app.inject({ method: "GET", url: "/v1/nothing" })).statusCode).toBe(404);
    // A broken address is just a page that isn't there, not a server error.
    expect((await app.inject({ method: "GET", url: "/%E0%A4%A" })).statusCode).toBeLessThan(500);
  });
});

describe("sandboxes under abuse", () => {
  it("one address keeps only a few: past its share, its own oldest goes, and nobody else's", async () => {
    let now = 1_000;
    const tenancy = await HostedTenancy.create({ dataRoot: temp(), webUrl: "https://wardy.example", maxSandboxes: 100, maxSandboxesPerAddress: 2, now: () => now });
    const other = await tenancy.createSandbox("10.0.0.2");
    const first = await tenancy.createSandbox("10.0.0.1");
    now += 10;
    await tenancy.createSandbox("10.0.0.1");
    now += 10;
    await tenancy.createSandbox("10.0.0.1");
    expect(tenancy.sandboxCount).toBe(3);
    expect(tenancy.forOwner(first.ownerToken)).toBeUndefined();
    expect(tenancy.forOwner(other.ownerToken)).toBeDefined();
  });

  it("a sandbox that has made all the requests a demo could need is cleared away, files and all", async () => {
    const dataRoot = temp();
    const tenancy = await HostedTenancy.create({ dataRoot, webUrl: "https://wardy.example", maxSandboxRequests: 3 });
    const one = await tenancy.createSandbox("10.0.0.1");
    for (let i = 0; i < 3; i += 1) expect(tenancy.forAgent(one.agentToken)).toBeDefined();
    expect(tenancy.forAgent(one.agentToken)).toBeUndefined();
    expect(tenancy.forOwner(one.ownerToken)).toBeUndefined();
    expect(existsSync(join(dataRoot, "sandboxes", one.key))).toBe(false);
  });

  it("the public demo, which anyone can send checks to, keeps nothing on disk", async () => {
    const dataRoot = temp();
    const { app } = await buildHostedApp({ dataRoot, webUrl: "https://wardy.example", indexHtml: "<!doctype html>", dist: temp() });
    const check = await app.inject({
      method: "POST",
      url: "/v1/check",
      payload: { requestId: crypto.randomUUID(), agentId: "x", ownerId: "someone-else.near", payee: "acme-sh0p.near", asset: "wNEAR", amount: "1", purpose: "t", createdAt: new Date().toISOString() },
    });
    expect(check.statusCode).toBe(200);
    expect(existsSync(join(dataRoot, "sandboxes", "public", "ledger.jsonl"))).toBe(false);
    expect(existsSync(join(dataRoot, "sandboxes", "public", "audit.jsonl"))).toBe(false);
    expect((await app.inject({ method: "GET", url: `/v1/verdicts/${check.json().verdictId}/verify` })).json().valid).toBe(true);
  });
});

describe("earnings on the hosted server", () => {
  it("every visitor's Earnings page shows the server's own sales, which start at zero", async () => {
    const { app, tenancy, sandbox, as } = await server();
    const one = await sandbox();
    const before = (await app.inject({ method: "GET", url: "/v1/stats", headers: as(one.ownerToken) })).json().earned;
    expect(before).toEqual({ checksSold: 0, revenue: [] });
    tenancy.publicWiring.earningsLog.record({ assignmentId: "a", jobId: "j", amount: "1", currency: "USDC", verdictId: "v", deliveredAt: "t" });
    const after = (await app.inject({ method: "GET", url: "/v1/stats", headers: as(one.ownerToken) })).json().earned;
    expect(after).toEqual({ checksSold: 1, revenue: [{ currency: "USDC", amount: "1" }], lastSale: { amount: "1", currency: "USDC" } });
  });
});
