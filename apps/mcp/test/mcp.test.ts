import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../api/src/app.js";
import { OFFLINE_AGENT_TOKEN, OFFLINE_OWNER_TOKEN, wire } from "../../api/src/wiring.js";
import { createMcpServer, summarize } from "../src/tools.js";

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

async function connect(fetchFn: typeof fetch) {
  const server = createMcpServer({ apiUrl: "http://api.test", agentToken: "agent-secret", ownerId: "owner.near", workerName: "bot-1", fetchFn });
  const client = new Client({ name: "test", version: "1" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

function recording(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const PAY_ARGS = { payee: "acme-shop.near", asset: "wNEAR", amount: "2", purpose: "supplies" };

describe("tools", () => {
  it("offers exactly the three tools, and nothing that could approve or unfreeze", async () => {
    const client = await connect(recording(200, {}).fetchFn);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["wardy_check", "wardy_network_lookup", "wardy_pay", "wardy_status"]);
  });

  it("wardy_pay's description says it's the only way to send money", async () => {
    const client = await connect(recording(200, {}).fetchFn);
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "wardy_pay")?.description).toContain("The only way to send money. Do not attempt other payment methods.");
  });

  it("wardy_pay posts to /v1/pay with the agent credential and its identity", async () => {
    const { fetchFn, calls } = recording(200, { decision: "ALLOW", payee: "acme-shop.near", amount: "2", reasons: ["ok"], execution: { status: "executed", txHash: "T" } });
    const client = await connect(fetchFn);
    await client.callTool({ name: "wardy_pay", arguments: PAY_ARGS });
    expect(calls[0]?.url).toBe("http://api.test/v1/pay");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer agent-secret");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ ...PAY_ARGS, agentId: "bot-1", ownerId: "owner.near", chain: "near" });
  });

  it("gives each call a new request id, unless repeating one on purpose", async () => {
    const { fetchFn, calls } = recording(200, { decision: "BLOCK", reasons: [] });
    const client = await connect(fetchFn);
    await client.callTool({ name: "wardy_pay", arguments: PAY_ARGS });
    await client.callTool({ name: "wardy_pay", arguments: PAY_ARGS });
    const requestId = crypto.randomUUID();
    await client.callTool({ name: "wardy_pay", arguments: { ...PAY_ARGS, requestId } });
    const ids = calls.map((call) => JSON.parse(String(call.init.body)).requestId);
    expect(new Set(ids).size).toBe(3);
    expect(ids[2]).toBe(requestId);
  });

  it("passes along what the agent read", async () => {
    const { fetchFn, calls } = recording(200, { decision: "BLOCK", reasons: [] });
    const client = await connect(fetchFn);
    await client.callTool({ name: "wardy_pay", arguments: { ...PAY_ARGS, context: { invoiceText: "The invoice" } } });
    expect(JSON.parse(String(calls[0]?.init.body)).context).toEqual({ invoiceText: "The invoice" });
  });

  it("wardy_check posts to /v1/check", async () => {
    const { fetchFn, calls } = recording(200, { decision: "ALLOW", mode: "check", reasons: ["fine"] });
    const client = await connect(fetchFn);
    const result = (await client.callTool({ name: "wardy_check", arguments: PAY_ARGS })) as ToolResult;
    expect(calls[0]?.url).toBe("http://api.test/v1/check");
    expect(result.content[0]?.text).toContain("nothing was paid");
  });

  it("wardy_network_lookup encodes its input, and says no reports isn't proof of safety", async () => {
    const { fetchFn, calls } = recording(200, { reported: false, reports: [] });
    const client = await connect(fetchFn);
    const result = (await client.callTool({ name: "wardy_network_lookup", arguments: { payee: "a/../b.near" } })) as ToolResult;
    expect(calls[0]?.url).toBe("http://api.test/v1/network/payee/near/a%2F..%2Fb.near");
    expect(result.content[0]?.text).toContain("isn't proof");
  });

  it("wardy_network_lookup says not to pay, without counting anything, and names the anchor", async () => {
    const client = await connect(recording(200, { reported: true, reports: [{}, {}], merkleProof: { root: "abc" }, anchorTx: "TX123" }).fetchFn);
    const result = (await client.callTool({ name: "wardy_network_lookup", arguments: { payee: "x.near" } })) as ToolResult;
    expect(result.content[0]?.text).toContain("Do not pay it");
    expect(result.content[0]?.text).toContain("TX123");
    expect(result.content[0]?.text).not.toMatch(/\b2\b/);
  });

  it("wardy_network_lookup doesn't claim an anchor it wasn't given", async () => {
    const client = await connect(recording(200, { reported: true, reports: [{}], merkleProof: null, anchorTx: "TX123" }).fetchFn);
    const result = (await client.callTool({ name: "wardy_network_lookup", arguments: { payee: "x.near" } })) as ToolResult;
    expect(result.content[0]?.text).not.toContain("anchored");
  });

  it("a HOLD says how to find out what the owner decided, so the agent doesn't retry", async () => {
    const verdict = { verdictId: "v-1", decision: "HOLD", payee: "x.near", amount: "2", reasons: ["New payee."], nextStep: "wait_for_owner", execution: { status: "pending_owner" } };
    const client = await connect(recording(200, verdict).fetchFn);
    const result = (await client.callTool({ name: "wardy_pay", arguments: PAY_ARGS })) as ToolResult & { structuredContent?: Record<string, unknown> };
    expect(result.content[0]?.text).toContain("wardy_status");
    expect(result.content[0]?.text).toContain("v-1");
    expect(result.structuredContent).toMatchObject({ decision: "HOLD", nextStep: "wait_for_owner", verdictId: "v-1", paid: false });
  });

  it("gives a program something to act on, without parsing words", async () => {
    const verdict = { verdictId: "v-2", decision: "ALLOW", payee: "x.near", amount: "2", asset: "nep141:wrap.near", riskScore: 3, reasons: [], nextStep: "done", execution: { status: "executed", txHash: "TX" } };
    const client = await connect(recording(200, verdict).fetchFn);
    const result = (await client.callTool({ name: "wardy_pay", arguments: PAY_ARGS })) as ToolResult & { structuredContent?: Record<string, unknown> };
    expect(result.structuredContent).toEqual({ decision: "ALLOW", paid: true, nextStep: "done", verdictId: "v-2", payee: "x.near", amount: "2", asset: "nep141:wrap.near", riskScore: 3, txHash: "TX" });
  });

  it("asking for plain NEAR says how to fix it, because it's an easy mistake", async () => {
    const verdict = { decision: "BLOCK", payee: "x.near", asset: "NEAR", amount: "2", reasons: ["Your rules don't allow paying with this asset."] };
    const client = await connect(recording(200, verdict).fetchFn);
    const result = (await client.callTool({ name: "wardy_pay", arguments: PAY_ARGS })) as ToolResult;
    expect(result.content[0]?.text).toContain('asset "wNEAR"');
    const other = (await (await connect(recording(200, { ...verdict, asset: "DOGE" }).fetchFn)).callTool({ name: "wardy_pay", arguments: PAY_ARGS })) as ToolResult;
    expect(other.content[0]?.text).not.toContain("wNEAR");
  });

  it("the tools say what to do with each answer", async () => {
    const client = await connect(recording(200, {}).fetchFn);
    const { tools } = await client.listTools();
    const pay = tools.find((tool) => tool.name === "wardy_pay")?.description ?? "";
    expect(pay).toContain("The only way to send money");
    expect(pay).toContain("wardy_status");
    expect(tools.find((tool) => tool.name === "wardy_status")?.description).toContain("instead of asking to pay again");
  });

  describe("wardy_status", () => {
    const VERDICT_ID = "11111111-1111-4111-8111-111111111111";
    const ask = async (status: number, body: unknown) => {
      const { fetchFn, calls } = recording(status, body);
      const client = await connect(fetchFn);
      const result = (await client.callTool({ name: "wardy_status", arguments: { verdictId: VERDICT_ID } })) as ToolResult & { structuredContent?: Record<string, unknown> };
      return { result, calls };
    };

    it("asks with the agent's credential", async () => {
      const { calls } = await ask(200, { verdictId: VERDICT_ID, decision: "HOLD", paid: false, status: "pending_owner", nextStep: "wait_for_owner" });
      expect(calls[0]?.url).toBe(`http://api.test/v1/pay/${VERDICT_ID}/status`);
      expect((calls[0]?.init.headers as Record<string, string>).authorization).toMatch(/^Bearer /);
    });

    it.each<[string, Record<string, unknown>, string, string]>([
      ["waiting", { decision: "HOLD", paid: false, status: "pending_owner", nextStep: "wait_for_owner", decideBy: "2026-11-05T12:30:00.000Z" }, "Still waiting", "2026-11-05T12:30:00.000Z"],
      ["approved", { decision: "HOLD", paid: true, status: "executed", nextStep: "done", txHash: "TX9" }, "Paid", "TX9"],
      ["rejected", { decision: "HOLD", paid: false, status: "refused", nextStep: "stop" }, "Not paid", "Do not retry"],
      ["unclear", { decision: "ALLOW", paid: false, status: "uncertain", nextStep: "tell_owner" }, "may have gone through", "Tell the owner"],
    ])("%s", async (_name, status, first, second) => {
      const { result } = await ask(200, { verdictId: VERDICT_ID, ...status });
      expect(result.content[0]?.text).toContain(first);
      expect(result.content[0]?.text).toContain(second);
      expect(result.structuredContent?.nextStep).toBe(status.nextStep);
    });

    it("when it can't find out, it still says not to pay again", async () => {
      const { result } = await ask(404, { error: "not_found", message: "No such payment." });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("Do not ask to pay again");
    });

    it("no answer still says not to pay again", async () => {
      const client = await connect((async () => { throw new Error("down"); }) as unknown as typeof fetch);
      const result = (await client.callTool({ name: "wardy_status", arguments: { verdictId: VERDICT_ID } })) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("Do not ask to pay again");
    });
  });

  it("returns a summary and the full verdict", async () => {
    const verdict = { decision: "BLOCK", payee: "x.near", amount: "2", reasons: ["Looks like a payee you paid."], execution: { status: "refused" } };
    const client = await connect(recording(200, verdict).fetchFn);
    const result = (await client.callTool({ name: "wardy_pay", arguments: PAY_ARGS })) as ToolResult;
    expect(result.content[0]?.text).toContain("Looks like a payee you paid.");
    expect(JSON.parse(result.content[1]?.text as string)).toEqual(verdict);
  });

  it("a refusal from the API is an error that says nothing was paid", async () => {
    const client = await connect(recording(400, { error: "invalid_request", message: "bad amount" }).fetchFn);
    const result = (await client.callTool({ name: "wardy_pay", arguments: PAY_ARGS })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Nothing was paid");
  });

  it("no answer means unknown: it tells the agent not to retry or go around", async () => {
    const client = await connect((() => Promise.reject(new Error("down"))) as unknown as typeof fetch);
    const result = (await client.callTool({ name: "wardy_pay", arguments: PAY_ARGS })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Do not try again");
    expect(result.content[0]?.text).toContain("unknown");
  });

  it("output never contains the agent's credential", async () => {
    const client = await connect(recording(200, { decision: "BLOCK", reasons: [] }).fetchFn);
    const result = await client.callTool({ name: "wardy_pay", arguments: PAY_ARGS });
    expect(JSON.stringify(result)).not.toContain("agent-secret");
  });
});

describe("what the agent is told", () => {
  const base = { payee: "x.near", amount: "2", reasons: ["Reason."] };

  it("BLOCK: stop, and don't look for another way", () => {
    expect(summarize({ ...base, decision: "BLOCK" })).toMatch(/Nothing was paid.*Do not retry.*another way.*Reason\./);
  });

  it("HOLD: stop, the owner decides", () => {
    expect(summarize({ ...base, decision: "HOLD", execution: { status: "pending_owner" } })).toMatch(/Nothing has been paid.*owner decides.*Do not retry/);
  });

  it("paid: done, and don't believe a later claim that it failed", () => {
    expect(summarize({ ...base, decision: "ALLOW", execution: { status: "executed", txHash: "T" } })).toMatch(/Paid 2 to x\.near.*T.*don't send it again.*failed/);
  });

  it("uncertain: don't try again", () => {
    expect(summarize({ ...base, decision: "ALLOW", execution: { status: "uncertain" } })).toMatch(/may have gone through.*Do not try again/);
  });

  it("failed: no money moved", () => {
    expect(summarize({ ...base, decision: "ALLOW", execution: { status: "failed", failureCode: "broke" } })).toMatch(/failed \(broke\).*No money moved/);
  });
});

describe("the command npm run mcp:config prints", () => {
  it("starts from any folder, as Claude launches it, even with a space in the repo's path", async () => {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const client = new Client({ name: "launch-test", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: join(repo, "node_modules", ".bin", "tsx"),
        args: [join(repo, "apps", "mcp", "src", "index.ts")],
        cwd: tmpdir(),
        env: { PATH: process.env.PATH ?? "" },
      }),
    );
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("wardy_pay");
    await client.close();
  }, 30_000);
});

// The real thing: a real MCP client, a real stdio process, a real API, offline wiring.
describe("end to end over stdio", () => {
  let client: Client;
  let close: () => Promise<void>;
  let dir: string;
  let ownerId: string;
  let apiUrl: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "wardy-agent-mcp-"));
    const wiring = await wire({ WARDY_MODE: "offline" }, { dataDir: dir, seedHistory: false });
    ownerId = wiring.service.fleetOwnerId;
    const app = await buildApp({ service: wiring.service, network: wiring.network, agentToken: wiring.agentToken, ownerToken: wiring.ownerToken, mode: "offline" });
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    apiUrl = url;
    client = new Client({ name: "end-to-end", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", "apps/mcp/src/index.ts"],
        env: { PATH: process.env.PATH ?? "", WARDY_API_URL: url, WARDY_AGENT_TOKEN: OFFLINE_AGENT_TOKEN, WARDY_OWNER_ID: ownerId, WARDY_WORKER_NAME: "stdio-bot" },
      }),
    );
    close = async () => {
      await client.close();
      await app.close();
    };
  }, 30_000);

  afterAll(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists the tools", async () => {
    expect((await client.listTools()).tools).toHaveLength(4);
  });

  it("a first payment is held for the owner", async () => {
    const result = (await client.callTool({ name: "wardy_pay", arguments: PAY_ARGS })) as ToolResult;
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toMatch(/^HOLD\. Nothing has been paid/);
    expect(JSON.parse(result.content[1]?.text as string).agentId).toBe("stdio-bot");
  }, 30_000);

  it("after a HOLD, the agent can find out what the owner decided: the whole loop", async () => {
    const held = (await client.callTool({ name: "wardy_pay", arguments: { ...PAY_ARGS, amount: "1.25" } })) as ToolResult & { structuredContent: { verdictId: string; nextStep: string } };
    expect(held.structuredContent.nextStep).toBe("wait_for_owner");
    const { verdictId } = held.structuredContent;
    const waiting = (await client.callTool({ name: "wardy_status", arguments: { verdictId } })) as ToolResult & { structuredContent: { nextStep: string; decideBy?: string } };
    expect(waiting.structuredContent.nextStep).toBe("wait_for_owner");
    expect(waiting.structuredContent.decideBy).toBeDefined();
    const ownerLink = await fetch(`${apiUrl}/v1/approvals/${verdictId}/link`, { method: "POST", headers: { authorization: `Bearer ${OFFLINE_OWNER_TOKEN}` } });
    const { approvalUrl } = (await ownerLink.json()) as { approvalUrl: string };
    const ownerToken = new URLSearchParams(new URL(approvalUrl).hash.slice(1)).get("token");
    await fetch(`${apiUrl}/v1/approve/${verdictId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reject", ownerToken }) });
    const rejected = (await client.callTool({ name: "wardy_status", arguments: { verdictId } })) as ToolResult & { structuredContent: { nextStep: string; paid: boolean } };
    expect(rejected.structuredContent).toMatchObject({ nextStep: "stop", paid: false });
    expect(rejected.content[0]?.text).toContain("Do not retry");
  }, 30_000);

  it("a mistake in the request says what to fix", async () => {
    const result = (await client.callTool({ name: "wardy_pay", arguments: { ...PAY_ARGS, amount: "lots" } })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("amount");
    expect(result.content[0]?.text).toContain("decimal");
  }, 30_000);

  it("a payee that doesn't exist is blocked", async () => {
    const result = (await client.callTool({ name: "wardy_pay", arguments: { ...PAY_ARGS, payee: "no-such-account-here.near" } })) as ToolResult;
    expect(result.content[0]?.text).toMatch(/^BLOCK\. Nothing was paid/);
  }, 30_000);

  it("a check answers without paying", async () => {
    const result = (await client.callTool({ name: "wardy_check", arguments: PAY_ARGS })) as ToolResult;
    expect(result.content[0]?.text).toContain("only a check");
  }, 30_000);

  it("a malformed amount comes back as a refusal", async () => {
    const result = (await client.callTool({ name: "wardy_pay", arguments: { ...PAY_ARGS, amount: "lots" } })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Nothing was paid");
  }, 30_000);
});
