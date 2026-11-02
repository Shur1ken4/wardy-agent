import { describe, expect, it } from "vitest";
import { getAccountFacts } from "../src/chain/nearChainData.js";

const OPTIONS = { rpcUrl: "https://rpc.test", nearblocksUrl: "https://blocks.test" };
const IMPLICIT = "a".repeat(64);
const CREATED_NANOS = 1613398225524785200;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const rpcFound = json({ result: { amount: "1" } });
const rpcUnknown = () => json({ error: { cause: { name: "UNKNOWN_ACCOUNT" } } });

/** Answers RPC calls with `rpc` and NearBlocks calls by URL suffix. */
function stub(rpc: () => Response, indexer: Record<string, () => Response> = {}) {
  const calls: string[] = [];
  const fetchFn = (async (input: string) => {
    calls.push(input);
    if (input === OPTIONS.rpcUrl) return rpc();
    const key = input.endsWith("/txns/count") ? "count" : "account";
    const answer = indexer[key];
    if (!answer) throw new Error(`unexpected call to ${input}`);
    return answer();
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("getAccountFacts", () => {
  it("reads age and transaction count for an existing account", async () => {
    const { fetchFn } = stub(() => rpcFound.clone(), {
      account: () =>
        json({ account: [{ account_id: "old.near", created: { block_timestamp: CREATED_NANOS } }] }),
      count: () => json({ txns: [{ count: "42" }] }),
    });
    expect(await getAccountFacts("old.near", { ...OPTIONS, fetchFn })).toEqual({
      accountId: "old.near",
      available: true,
      exists: true,
      implicit: false,
      createdAt: new Date(CREATED_NANOS / 1e6).toISOString(),
      txCount: 42,
    });
  });

  it("reports a missing named account without spending indexer calls", async () => {
    const { fetchFn, calls } = stub(rpcUnknown);
    const facts = await getAccountFacts("missing.near", { ...OPTIONS, fetchFn });
    expect(facts).toMatchObject({ available: true, exists: false, implicit: false });
    expect(calls).toEqual([OPTIONS.rpcUrl]);
  });

  it("reads the older RPC error shape as missing too", async () => {
    const { fetchFn } = stub(() => json({ result: { error: "account missing.near does not exist while viewing" } }));
    expect(await getAccountFacts("missing.near", { ...OPTIONS, fetchFn })).toMatchObject({
      available: true,
      exists: false,
    });
  });

  it("marks an unfunded 64-hex account as implicit, not an error", async () => {
    const { fetchFn } = stub(rpcUnknown);
    expect(await getAccountFacts(IMPLICIT, { ...OPTIONS, fetchFn })).toMatchObject({
      available: true,
      exists: false,
      implicit: true,
    });
  });

  it("says unavailable when RPC is down", async () => {
    const fetchFn = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await getAccountFacts("any.near", { ...OPTIONS, fetchFn })).toMatchObject({
      available: false,
      exists: false,
    });
  });

  it("says unavailable on an RPC error it can't interpret", async () => {
    const { fetchFn } = stub(() => json({ error: { cause: { name: "INTERNAL_ERROR" } } }));
    expect(await getAccountFacts("any.near", { ...OPTIONS, fetchFn })).toMatchObject({ available: false });
  });

  it("doesn't read the indexer's HTTP 200 stub as data", async () => {
    const { fetchFn } = stub(() => rpcFound.clone(), {
      account: () => json({ account: [{ block_height: "1", block_hash: "x" }] }),
      count: () => json({ txns: [{ count: "0" }] }),
    });
    expect(await getAccountFacts("new.near", { ...OPTIONS, fetchFn })).toMatchObject({
      exists: true,
      createdAt: null,
      txCount: 0,
    });
  });

  it("keeps existence when the indexer rate-limits", async () => {
    const { fetchFn } = stub(() => rpcFound.clone(), {
      account: () => json({ message: "rate limited" }, 429),
      count: () => json({ message: "rate limited" }, 429),
    });
    expect(await getAccountFacts("busy.near", { ...OPTIONS, fetchFn })).toMatchObject({
      available: true,
      exists: true,
      createdAt: null,
      txCount: null,
    });
  });

  it("sends the API key only when one is set", async () => {
    const seen: (string | null)[] = [];
    const fetchFn = (async (input: string, init: RequestInit) => {
      if (input === OPTIONS.rpcUrl) return rpcFound.clone();
      seen.push(new Headers(init.headers).get("authorization"));
      return json({ account: [], txns: [] });
    }) as unknown as typeof fetch;
    await getAccountFacts("a.near", { ...OPTIONS, fetchFn });
    await getAccountFacts("a.near", { ...OPTIONS, fetchFn, nearblocksApiKey: "k" });
    expect(seen).toEqual([null, null, "Bearer k", "Bearer k"]);
  });
});
