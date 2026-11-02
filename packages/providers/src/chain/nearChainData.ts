// Account facts for the new-account detector. RPC says whether an account exists; NearBlocks adds its
// age and transaction count. Nothing here throws: when a source is down, the facts say so, and the
// detector reports ACCOUNT_DATA_UNAVAILABLE instead of crashing.
import { type AccountFacts, type AccountFactsSource, isImplicitAccount } from "@wardy-agent/core";

export type { AccountFacts };

export interface ChainDataOptions {
  rpcUrl: string;
  nearblocksUrl: string;
  nearblocksApiKey?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  { fetchFn = fetch, timeoutMs = 15_000 }: ChainDataOptions,
): Promise<{ status: number; body: any } | null> {
  try {
    const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { status: response.status, body: await response.json() };
  } catch {
    return null;
  }
}

/** True or false when RPC gave a clear answer, null when it couldn't. */
async function accountExists(accountId: string, options: ChainDataOptions): Promise<boolean | null> {
  const answer = await fetchJson(
    options.rpcUrl,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "wardy-agent",
        method: "query",
        params: { request_type: "view_account", finality: "final", account_id: accountId },
      }),
    },
    options,
  );
  if (!answer) return null;
  if (typeof answer.body?.result?.amount === "string") return true;
  const cause = answer.body?.error?.cause?.name ?? answer.body?.result?.error;
  if (cause === "UNKNOWN_ACCOUNT") return false;
  if (typeof cause === "string" && cause.includes("does not exist")) return false;
  return null;
}

async function indexerFacts(
  accountId: string,
  options: ChainDataOptions,
): Promise<Pick<AccountFacts, "createdAt" | "txCount">> {
  const headers: Record<string, string> = options.nearblocksApiKey
    ? { authorization: `Bearer ${options.nearblocksApiKey}` }
    : {};
  const base = `${options.nearblocksUrl}/v1/account/${encodeURIComponent(accountId)}`;
  const account = await fetchJson(base, { headers }, options);
  // An unknown account answers HTTP 200 with a stub that has no account_id, so check for it.
  const row = account?.status === 200 ? account.body?.account?.[0] : undefined;
  const nanos = row?.account_id === accountId ? row?.created?.block_timestamp : undefined;
  const createdAt = typeof nanos === "number" ? new Date(nanos / 1e6).toISOString() : null;

  const count = await fetchJson(`${base}/txns/count`, { headers }, options);
  const rawCount = count?.status === 200 ? count.body?.txns?.[0]?.count : undefined;
  const txCount = rawCount === undefined || Number.isNaN(Number(rawCount)) ? null : Number(rawCount);
  return { createdAt, txCount };
}

export async function getAccountFacts(accountId: string, options: ChainDataOptions): Promise<AccountFacts> {
  const implicit = isImplicitAccount(accountId);
  const exists = await accountExists(accountId, options);
  if (exists === null) {
    return { accountId, available: false, exists: false, implicit, createdAt: null, txCount: null };
  }
  // No need to spend indexer calls (about 6 a minute on the free tier) on an absent account.
  if (!exists) return { accountId, available: true, exists: false, implicit, createdAt: null, txCount: null };
  return { accountId, available: true, exists: true, implicit, ...(await indexerFacts(accountId, options)) };
}

/** RPC and NearBlocks answers are cached, because the free tier allows about 6 calls a minute. */
export class NearChainData implements AccountFactsSource {
  private readonly cache = new Map<string, { facts: AccountFacts; expires: number }>();

  constructor(
    private readonly options: ChainDataOptions,
    private readonly cacheMs = 10 * 60_000,
  ) {}

  async getAccountFacts(accountId: string): Promise<AccountFacts> {
    const cached = this.cache.get(accountId);
    if (cached && cached.expires > Date.now()) return cached.facts;
    const facts = await getAccountFacts(accountId, this.options);
    // A failed lookup isn't remembered, so the next request tries again.
    if (facts.available && (!facts.exists || facts.createdAt !== null)) {
      this.cache.set(accountId, { facts, expires: Date.now() + this.cacheMs });
    }
    return facts;
  }
}
