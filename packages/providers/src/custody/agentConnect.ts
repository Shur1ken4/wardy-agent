// NEAR Intents Agent API ("Agent Connect"): live custody on mainnet. Wardy Agent holds the only grant. The API's
// recovery rules drive the mapping here: only a proven refusal counts as failed; after a lost response or an
// UNCERTAIN status the outcome is unknown, and the same operation must never be sent under a new key.
import { type CustodyProvider, type CustodyResult, type CustodyTransfer, USDC_ASSET, WNEAR_ASSET } from "@wardy-agent/core";
import { toAtomic } from "../amount.js";

const DECIMALS: Record<string, number> = { [WNEAR_ASSET]: 24, [USDC_ASSET]: 6 };

/** The parts of the SDK client this adapter uses, so tests can run without real money. */
export interface AgentApiLike {
  forGrant(token: string): AgentApiLike;
  transfer(agentId: string, request: { asset: string; amount: string; recipient: string }, options: { idempotencyKey: string }): Promise<{ correlation_id: string }>;
  getStatus(correlationId: string, options?: { waitMs?: number }): Promise<{ status: string; failure_code?: string | null; details?: unknown }>;
  getBalances(agentId: string): Promise<{ balances: { asset_id: string; balance: string | null }[] }>;
  getTokens(): Promise<{ asset_id: string; price?: number | null }[]>;
}

export interface AgentConnectOptions {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  grantToken: string;
  statusTimeoutMs?: number;
  /** Injected in tests. By default the SDK loads on first use, so offline mode never touches it. */
  client?: AgentApiLike;
}

/** The API's status details vary by operation, so this looks for a transaction hash anywhere inside them. */
export function findTxHash(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (/(^|_)(tx|transaction)_?hash$/i.test(key) && typeof item === "string" && item) return item;
    if (/(^|_)(tx|transaction)_?hashes$/i.test(key) && Array.isArray(item) && typeof item[0] === "string") return item[0];
    const nested = findTxHash(item);
    if (nested) return nested;
  }
  return undefined;
}

export class AgentConnectCustody implements CustodyProvider {
  readonly name = "agent-connect";
  private loaded?: AgentApiLike;

  constructor(private readonly options: AgentConnectOptions) {
    this.loaded = options.client;
  }

  private async api(): Promise<AgentApiLike> {
    if (!this.loaded) {
      const { AgentApi } = await import("@near-intents-agent-api/sdk");
      this.loaded = new AgentApi({ baseUrl: this.options.apiUrl, apiKey: this.options.apiKey }) as unknown as AgentApiLike;
    }
    return this.loaded;
  }

  async transfer(request: CustodyTransfer): Promise<CustodyResult> {
    const fail = (failureCode: string, reference?: string): CustodyResult => ({
      status: "failed",
      provider: this.name,
      failureCode,
      ...(reference ? { reference } : {}),
    });
    const uncertain = (failureCode: string, reference?: string): CustodyResult => ({
      status: "uncertain",
      provider: this.name,
      failureCode,
      ...(reference ? { reference } : {}),
    });

    const decimals = DECIMALS[request.asset];
    if (decimals === undefined) return fail("unsupported_asset");
    let amount: string;
    try {
      amount = toAtomic(request.amount, decimals).toString();
    } catch {
      return fail("invalid_amount");
    }

    const api = await this.api();
    let correlationId: string;
    try {
      const started = await api
        .forGrant(this.options.grantToken)
        .transfer(this.options.agentId, { asset: request.asset, amount, recipient: request.to }, { idempotencyKey: request.idempotencyKey });
      correlationId = started.correlation_id;
    } catch (error) {
      const { status, code, retryable } = error as { status?: number; code?: string; retryable?: boolean };
      // A clear refusal from the API moved nothing. Anything else might have.
      if (typeof status === "number" && status < 500 && !retryable) return fail(code ?? `http_${status}`);
      return uncertain(code ?? "custody_no_answer");
    }

    const deadline = Date.now() + (this.options.statusTimeoutMs ?? 5 * 60_000);
    while (Date.now() < deadline) {
      let status: Awaited<ReturnType<AgentApiLike["getStatus"]>>;
      try {
        status = await api.getStatus(correlationId, { waitMs: 30_000 });
      } catch {
        return uncertain("status_no_answer", correlationId);
      }
      if (status.status === "PROCESSING" || status.status === "QUEUED") continue;
      if (status.status === "SUCCESS") {
        const txHash = findTxHash(status.details);
        return { status: "executed", provider: this.name, reference: correlationId, ...(txHash ? { txHash } : {}) };
      }
      if (status.status === "FAILED" || status.status === "REFUNDED") {
        return fail(status.failure_code ?? status.status.toLowerCase(), correlationId);
      }
      // UNCERTAIN, NEEDS_REVIEW, or a status that's new to us.
      return uncertain(status.failure_code ?? status.status.toLowerCase(), correlationId);
    }
    return uncertain("status_timeout", correlationId);
  }

  /** Values everything the agent holds in NEAR, for the live-mode safety limit. */
  async balanceNearEquivalent(): Promise<number> {
    const api = await this.api();
    const [{ balances }, tokens] = await Promise.all([api.getBalances(this.options.agentId), api.getTokens()]);
    const price = (assetId: string) => tokens.find((token) => token.asset_id === assetId)?.price ?? null;
    const nearPrice = price(WNEAR_ASSET);
    if (!nearPrice) throw new Error("Couldn't read the NEAR price, so the balance can't be checked.");
    let usd = 0;
    for (const { asset_id: assetId, balance } of balances) {
      const amount = Number(balance ?? 0);
      if (amount === 0) continue;
      const assetPrice = price(assetId);
      // Fail closed: an asset we can't value might be worth a lot.
      if (!assetPrice) throw new Error(`Couldn't value ${assetId}, so the balance can't be checked.`);
      usd += amount * assetPrice;
    }
    return usd / nearPrice;
  }
}
