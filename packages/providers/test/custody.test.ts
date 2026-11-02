import { USDC_ASSET, WNEAR_ASSET } from "@wardy-agent/core";
import { describe, expect, it, vi } from "vitest";
import { type AgentApiLike, AgentConnectCustody, findTxHash } from "../src/custody/agentConnect.js";
import { OutLayerCustody } from "../src/custody/outlayer.js";

const TRANSFER = { to: "merchant.testnet", asset: WNEAR_ASSET, amount: "0.001", memo: "verdict-1", idempotencyKey: "request-0001" };

describe("OutLayerCustody", () => {
  const API = "https://testnet-api.outlayer.ai";

  function custodyAnswering(status: number, body: unknown) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { custody: new OutLayerCustody({ apiUrl: API, apiKey: "wk_test", fetchFn }), calls };
  }

  it("sends yocto, the key and the idempotency header", async () => {
    const { custody, calls } = custodyAnswering(200, { request_id: "r1", status: "success", tx_hash: "HASH" });
    await custody.transfer(TRANSFER);
    expect(calls[0]?.url).toBe(`${API}/wallet/v1/transfer`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ to: "merchant.testnet", amount: "1000000000000000000000" });
    expect(new Headers(calls[0]?.init.headers).get("x-idempotency-key")).toBe("request-0001");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer wk_test");
  });

  // Every body below was captured from a real testnet call on 2026-11-02.
  it("a success", async () => {
    const { custody } = custodyAnswering(200, { request_id: "a0ea59a3", status: "success", tx_hash: "FAsfHrpW" });
    expect(await custody.transfer(TRANSFER)).toEqual({ status: "executed", provider: "outlayer-testnet", txHash: "FAsfHrpW", reference: "a0ea59a3" });
  });

  it("a replayed key, which answers 200 with the first result nested", async () => {
    const { custody } = custodyAnswering(200, {
      error: "duplicate_idempotency_key",
      request_id: "a0ea59a3",
      type: "transfer",
      status: "success",
      result: { result: null, tx_hash: "FAsfHrpW" },
    });
    expect(await custody.transfer(TRANSFER)).toMatchObject({ status: "executed", txHash: "FAsfHrpW" });
  });

  it("a revert on-chain: the transaction exists, but no money moved", async () => {
    const { custody } = custodyAnswering(422, { error: "onchain_tx_failed", tx_hash: "GDjezM8X" });
    expect(await custody.transfer(TRANSFER)).toMatchObject({ status: "failed", failureCode: "onchain_tx_failed", txHash: "GDjezM8X" });
  });

  it("an underfunded wallet", async () => {
    const { custody } = custodyAnswering(402, { error: "wallet_underfunded", message: "This wallet cannot pay" });
    expect(await custody.transfer(TRANSFER)).toMatchObject({ status: "failed", failureCode: "wallet_underfunded" });
  });

  it("the daily limit", async () => {
    const { custody } = custodyAnswering(429, { error: "operation_limit_reached" });
    expect(await custody.transfer(TRANSFER)).toMatchObject({ status: "failed", failureCode: "operation_limit_reached" });
  });

  it.each([
    ["a server error", 500, {}],
    ["a bad gateway", 502, {}],
    ["still processing", 200, { request_id: "r1", status: "processing" }],
    ["needs review, which may already have fired", 200, { request_id: "r1", status: "needs_review" }],
    ["a status we've never seen", 200, { request_id: "r1", status: "surprising" }],
  ])("%s is uncertain, never failed", async (_name, status, body) => {
    const { custody } = custodyAnswering(status, body);
    expect((await custody.transfer(TRANSFER)).status).toBe("uncertain");
  });

  it("no answer at all is uncertain", async () => {
    const fetchFn = (() => Promise.reject(new Error("timeout"))) as unknown as typeof fetch;
    const custody = new OutLayerCustody({ apiUrl: API, apiKey: "k", fetchFn });
    expect(await custody.transfer(TRANSFER)).toMatchObject({ status: "uncertain", failureCode: "custody_no_answer" });
  });

  it("USDC has no test equivalent", async () => {
    const { custody, calls } = custodyAnswering(200, {});
    expect(await custody.transfer({ ...TRANSFER, asset: USDC_ASSET })).toMatchObject({ status: "failed", failureCode: "asset_not_on_testnet" });
    expect(calls).toEqual([]);
  });

  it("an amount too precise for the token never reaches the network", async () => {
    const { custody, calls } = custodyAnswering(200, {});
    expect(await custody.transfer({ ...TRANSFER, amount: `0.${"1".repeat(25)}` })).toMatchObject({ status: "failed", failureCode: "invalid_amount" });
    expect(calls).toEqual([]);
  });

  it("refuses to run against mainnet: it sends native NEAR, which skips the provider's rules", () => {
    expect(() => new OutLayerCustody({ apiUrl: "https://api.outlayer.ai", apiKey: "k" })).toThrow(/testnet only/);
  });
});

describe("AgentConnectCustody", () => {
  function fake(overrides: Partial<AgentApiLike> = {}) {
    const client: AgentApiLike = {
      forGrant: vi.fn(() => client),
      transfer: vi.fn(async () => ({ correlation_id: "op_1" })),
      getStatus: vi.fn(async () => ({ status: "SUCCESS", details: { transaction_hash: "HASH" } })),
      getBalances: vi.fn(async () => ({ balances: [] })),
      getTokens: vi.fn(async () => []),
      ...overrides,
    };
    return client;
  }

  function custody(client: AgentApiLike, statusTimeoutMs?: number) {
    return new AgentConnectCustody({
      apiUrl: "https://api.test",
      apiKey: "naa_test",
      agentId: "agent-1",
      grantToken: "ngt_test",
      client,
      ...(statusTimeoutMs === undefined ? {} : { statusTimeoutMs }),
    });
  }

  const TO_MERCHANT = { to: "merchant.near", asset: WNEAR_ASSET, amount: "0.01", memo: "v", idempotencyKey: "request-0001" };

  it("spends under the grant, with atomic units, and keeps the key", async () => {
    const client = fake();
    await custody(client).transfer(TO_MERCHANT);
    expect(client.forGrant).toHaveBeenCalledWith("ngt_test");
    expect(client.transfer).toHaveBeenCalledWith(
      "agent-1",
      { asset: WNEAR_ASSET, amount: "10000000000000000000000", recipient: "merchant.near" },
      { idempotencyKey: "request-0001" },
    );
  });

  it("uses each token's own decimals", async () => {
    const client = fake();
    await custody(client).transfer({ ...TO_MERCHANT, asset: USDC_ASSET, amount: "0.01" });
    expect(client.transfer).toHaveBeenCalledWith("agent-1", expect.objectContaining({ amount: "10000" }), expect.anything());
  });

  it("refuses an asset it doesn't know, rather than guessing decimals", async () => {
    const client = fake();
    expect(await custody(client).transfer({ ...TO_MERCHANT, asset: "near" })).toMatchObject({ status: "failed", failureCode: "unsupported_asset" });
    expect(client.transfer).not.toHaveBeenCalled();
  });

  it("SUCCESS is executed, with the operation id and any tx hash", async () => {
    expect(await custody(fake()).transfer(TO_MERCHANT)).toEqual({ status: "executed", provider: "agent-connect", reference: "op_1", txHash: "HASH" });
  });

  it("keeps polling while it's processing", async () => {
    const getStatus = vi.fn().mockResolvedValueOnce({ status: "PROCESSING" }).mockResolvedValueOnce({ status: "QUEUED" }).mockResolvedValue({ status: "SUCCESS" });
    expect((await custody(fake({ getStatus })).transfer(TO_MERCHANT)).status).toBe("executed");
    expect(getStatus).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["FAILED", "some_failure"],
    ["REFUNDED", "refunded"],
  ])("%s is failed", async (status, code) => {
    const client = fake({ getStatus: vi.fn(async () => ({ status, failure_code: status === "FAILED" ? code : null })) });
    expect(await custody(client).transfer(TO_MERCHANT)).toMatchObject({ status: "failed", failureCode: code, reference: "op_1" });
  });

  it.each(["UNCERTAIN", "NEEDS_REVIEW", "SOMETHING_NEW"])("%s is uncertain, never failed", async (status) => {
    expect((await custody(fake({ getStatus: vi.fn(async () => ({ status })) })).transfer(TO_MERCHANT)).status).toBe("uncertain");
  });

  it("a timeout while polling is uncertain", async () => {
    const client = fake({ getStatus: vi.fn(async () => ({ status: "PROCESSING" })) });
    expect(await custody(client, 0).transfer(TO_MERCHANT)).toMatchObject({ status: "uncertain", failureCode: "status_timeout", reference: "op_1" });
  });

  it("losing the connection while polling is uncertain", async () => {
    const client = fake({ getStatus: vi.fn(() => Promise.reject(new Error("gone"))) });
    expect((await custody(client).transfer(TO_MERCHANT)).status).toBe("uncertain");
  });

  it("a clear refusal is failed: nothing was sent", async () => {
    const refusal = Object.assign(new Error("no"), { status: 403, code: "policy_destination_denied", retryable: false });
    const client = fake({ transfer: vi.fn(() => Promise.reject(refusal)) });
    expect(await custody(client).transfer(TO_MERCHANT)).toMatchObject({ status: "failed", failureCode: "policy_destination_denied" });
  });

  it.each([
    ["a server failure", { status: 500, code: "internal_error", retryable: true }],
    ["a throttle the API says to retry", { status: 429, code: "rate_limited", retryable: true }],
    ["a lost connection", {}],
  ])("%s is uncertain: the API says it may have taken effect", async (_name, fields) => {
    const client = fake({ transfer: vi.fn(() => Promise.reject(Object.assign(new Error("x"), fields))) });
    expect((await custody(client).transfer(TO_MERCHANT)).status).toBe("uncertain");
  });

  describe("the live-mode balance check", () => {
    const tokens = vi.fn(async () => [
      { asset_id: WNEAR_ASSET, price: 4 },
      { asset_id: USDC_ASSET, price: 1 },
    ]);

    it("values everything in NEAR", async () => {
      const client = fake({
        getTokens: tokens,
        getBalances: vi.fn(async () => ({
          balances: [
            { asset_id: WNEAR_ASSET, balance: "2" },
            { asset_id: USDC_ASSET, balance: "8" },
          ],
        })),
      });
      expect(await custody(client).balanceNearEquivalent()).toBe(4);
    });

    it("refuses to guess when an asset can't be valued", async () => {
      const client = fake({ getTokens: tokens, getBalances: vi.fn(async () => ({ balances: [{ asset_id: "nep141:mystery.near", balance: "5" }] })) });
      await expect(custody(client).balanceNearEquivalent()).rejects.toThrow(/Couldn't value/);
    });

    it("refuses to guess without a NEAR price", async () => {
      await expect(custody(fake({ getTokens: vi.fn(async () => []) })).balanceNearEquivalent()).rejects.toThrow(/NEAR price/);
    });
  });
});

describe("findTxHash", () => {
  it.each([
    [{ transaction_hash: "A" }, "A"],
    [{ tx_hash: "B" }, "B"],
    [{ settlement: { evidence: { transaction_hash: "C" } } }, "C"],
    [{ transaction_hashes: ["D", "E"] }, "D"],
    [{ other: 1 }, undefined],
    [null, undefined],
    ["text", undefined],
  ])("%j gives %s", (input, expected) => {
    expect(findTxHash(input)).toBe(expected);
  });
});
