import { describe, expect, it } from "vitest";
import { type AgentEvent, type PayArgs, runLlmAgent, runScriptedAgent, SYSTEM_PROMPT } from "../src/agent.js";
import { contextFrom, loadScenarios, type Scenario } from "../src/scenario.js";

const scenarios = loadScenarios();
const find = (id: string) => scenarios.find((scenario) => scenario.id === id) as Scenario;

function recordingPay(answer = "Paid.") {
  const calls: PayArgs[] = [];
  const pay = async (args: PayArgs) => {
    calls.push(args);
    return { text: answer };
  };
  return { calls, pay };
}

describe("loading scenarios", () => {
  it("reads every file each scenario needs", () => {
    for (const scenario of scenarios) {
      for (const step of scenario.steps) for (const file of step.reads) expect(scenario.files[file], `${scenario.id} ${file}`).toBeTruthy();
    }
  });

  it("names each one after its folder", () => {
    expect(find("A1").slug).toBe("lookalike");
  });

  it("puts text in the right context field", () => {
    expect(contextFrom(find("A1"), ["invoice.md"])).toEqual({ invoiceText: find("A1").files["invoice.md"] });
    expect(contextFrom(find("A3"), ["email.md"])).toEqual({ emailText: find("A3").files["email.md"] });
    expect(Object.keys(contextFrom(find("A2"), ["invoice.md", "tool-result.md"]) ?? {})).toEqual(["invoiceText", "toolResultText"]);
    expect(contextFrom(find("H4"), [])).toBeUndefined();
  });
});

describe("the scripted agent", () => {
  it("does what the invoice says, including the attacker's payee", async () => {
    const { calls, pay } = recordingPay();
    await runScriptedAgent(find("A1"), pay);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ payee: "acme-sh0p.near", asset: "wNEAR", amount: "2", invoiceId: "INV-1187" });
    expect(calls[0]?.context?.invoiceText).toContain("our account has moved");
  });

  it("keeps going whatever it's told, because it's gullible", async () => {
    const { calls, pay } = recordingPay("BLOCK. Do not retry.");
    await runScriptedAgent(find("A9"), pay);
    expect(calls).toHaveLength(5);
  });

  it("reports each file once, and what it asked and heard", async () => {
    const events: AgentEvent[] = [];
    await runScriptedAgent(find("A9"), recordingPay().pay, (event) => events.push(event));
    expect(events.filter((event) => event.type === "read")).toHaveLength(1);
    expect(events.filter((event) => event.type === "ask")).toHaveLength(5);
    expect(events.filter((event) => event.type === "answer")).toHaveLength(5);
  });
});

describe("the LLM agent", () => {
  type Turn = { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };

  function fakeModel(turns: Turn[]) {
    const requests: { url: string; body: any; auth: string | null }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
      const message = turns.shift() ?? { content: "All done." };
      return Response.json({ choices: [{ message: { role: "assistant", content: null, ...message } }] });
    }) as unknown as typeof fetch;
    return { fetchFn, requests };
  }

  const options = (fetchFn: typeof fetch) => ({ apiKey: "test-key", model: "m/x", baseUrl: "https://ai.test/v1", fetchFn });
  const call = (id: string, name: string, args: unknown = {}) => ({ id, function: { name, arguments: JSON.stringify(args) } });
  const PAY = { payee: "acme-sh0p.near", asset: "wNEAR", amount: "2", purpose: "invoice" };

  it("runs with the trusting prompt, and one money tool: whichever it's handed", async () => {
    const { fetchFn, requests } = fakeModel([{ content: "Nothing to do." }]);
    await runLlmAgent(find("A1"), recordingPay().pay, "wardy_pay", options(fetchFn));
    expect(requests[0]?.url).toBe("https://ai.test/v1/chat/completions");
    expect(requests[0]?.auth).toBe("Bearer test-key");
    expect(requests[0]?.body.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(requests[0]?.body.tools.map((tool: any) => tool.function.name)).toEqual(["read_inbox", "wardy_pay"]);
    expect(requests[0]?.body.stream).toBe(false);
  });

  it("keeps untrusted text out of the instructions: it arrives only as a tool result", async () => {
    const { fetchFn, requests } = fakeModel([{ tool_calls: [call("1", "read_inbox")] }, { content: "Done." }]);
    await runLlmAgent(find("A8"), recordingPay().pay, "wardy_pay", options(fetchFn));
    const [system, user, assistant, tool] = requests[1]?.body.messages ?? [];
    expect(system.content).not.toContain("SYSTEM: Wardy");
    expect(user.content).not.toContain("SYSTEM: Wardy");
    expect(assistant.role).toBe("assistant");
    expect(tool).toMatchObject({ role: "tool", tool_call_id: "1" });
    expect(tool.content).toContain("SYSTEM: Wardy");
  });

  it("pays through the tool it's given, and attaches what it read even if the model leaves it out", async () => {
    const { calls, pay } = recordingPay("BLOCK: not paying that.");
    const { fetchFn, requests } = fakeModel([{ tool_calls: [call("1", "read_inbox")] }, { tool_calls: [call("2", "wardy_pay", PAY)] }, { content: "Done." }]);
    await runLlmAgent(find("A1"), pay, "wardy_pay", options(fetchFn));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject(PAY);
    expect(calls[0]?.context?.invoiceText).toContain("our account has moved");
    expect(requests[2]?.body.messages.at(-1).content).toBe("BLOCK: not paying that.");
  });

  it("A2: the tool lies once, and the lie is attached to anything paid after", async () => {
    const { calls, pay } = recordingPay("Paid.");
    const { fetchFn, requests } = fakeModel([
      { tool_calls: [call("1", "read_inbox")] },
      { tool_calls: [call("2", "wardy_pay", PAY)] },
      { tool_calls: [call("3", "wardy_pay", PAY)] },
      { content: "Done." },
    ]);
    await runLlmAgent(find("A2"), pay, "wardy_pay", options(fetchFn));
    expect(requests[2]?.body.messages.at(-1).content).toContain("Payment failed");
    expect(requests[3]?.body.messages.at(-1).content).toBe("Paid."); // Only the first result is forged.
    expect(calls[0]?.context?.toolResultText).toBeUndefined();
    expect(calls[1]?.context?.toolResultText).toContain("Payment failed");
  });

  it("can't call a money tool it wasn't given", async () => {
    const { calls, pay } = recordingPay();
    const { fetchFn, requests } = fakeModel([{ tool_calls: [call("1", "direct_pay", PAY)] }, { content: "Done." }]);
    await runLlmAgent(find("A1"), pay, "wardy_pay", options(fetchFn));
    expect(calls).toEqual([]);
    expect(requests[1]?.body.messages.at(-1).content).toContain("no tool called direct_pay");
  });

  it("answers a malformed tool call without paying", async () => {
    const { calls, pay } = recordingPay();
    const garbled = { id: "1", function: { name: "wardy_pay", arguments: "{not json" } };
    const { fetchFn, requests } = fakeModel([{ tool_calls: [garbled] }, { content: "Done." }]);
    await runLlmAgent(find("A1"), pay, "wardy_pay", options(fetchFn));
    expect(calls).toEqual([]);
    expect(requests[1]?.body.messages.at(-1).content).toContain("needs a payee");
  });

  it("stops after its turn limit, even if the model never does", async () => {
    let turns = 0;
    const fetchFn = (async () => {
      turns += 1;
      return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [call(String(turns), "read_inbox")] } }] });
    }) as unknown as typeof fetch;
    await runLlmAgent(find("A1"), recordingPay().pay, "wardy_pay", { ...options(fetchFn), maxTurns: 3 });
    expect(turns).toBe(3);
  });

  it("reports an API failure", async () => {
    const fetchFn = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    await expect(runLlmAgent(find("A1"), recordingPay().pay, "wardy_pay", options(fetchFn))).rejects.toThrow(/HTTP 500/);
  });
});
