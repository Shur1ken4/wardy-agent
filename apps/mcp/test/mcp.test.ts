import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../api/src/app.js";
import { OFFLINE_AGENT_TOKEN, wire } from "../../api/src/wiring.js";
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
    expect(tools.map((tool) => tool.name).sort()).toEqual(["wardy_check", "wardy_network_lookup", "wardy_pay"]);
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

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "wardy-agent-mcp-"));
    const wiring = await wire({ WARDY_MODE: "offline" }, { dataDir: dir, seedHistory: false });
    ownerId = wiring.service.fleetOwnerId;
    const app = await buildApp({ service: wiring.service, reports: wiring.reports, agentToken: wiring.agentToken, ownerToken: wiring.ownerToken, mode: "offline" });
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
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
    expect((await client.listTools()).tools).toHaveLength(3);
  });

  it("a first payment is held for the owner", async () => {
    const result = (await client.callTool({ name: "wardy_pay", arguments: PAY_ARGS })) as ToolResult;
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toMatch(/^HOLD\. Nothing has been paid/);
    expect(JSON.parse(result.content[1]?.text as string).agentId).toBe("stdio-bot");
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
