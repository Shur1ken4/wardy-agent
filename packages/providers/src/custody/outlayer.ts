// OutLayer custody on NEAR testnet: real transactions with free test tokens. Response shapes were read from real
// calls, because the docs don't show them: a success returns { request_id, status, tx_hash }, and a replayed
// X-Idempotency-Key returns HTTP 200 with the first result and moves nothing.
import { type CustodyProvider, type CustodyResult, type CustodyTransfer, WNEAR_ASSET } from "@wardy-agent/core";
import { toAtomic } from "../amount.js";

export interface OutLayerOptions {
  apiUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

// A refusal that proves nothing moved. Anything else unexpected might have, so it's reported as uncertain.
const NOTHING_MOVED = new Set([400, 401, 402, 403, 404, 429]);

export class OutLayerCustody implements CustodyProvider {
  readonly name = "outlayer-testnet";

  constructor(private readonly options: OutLayerOptions) {
    // This adapter sends native NEAR, which skips the rules Wardy Agent relies on in live custody.
    if (!new URL(options.apiUrl).hostname.includes("testnet")) {
      throw new Error("OutLayerCustody is for testnet only. Mainnet payments go through Agent Connect.");
    }
  }

  private fail(failureCode: string): CustodyResult {
    return { status: "failed", provider: this.name, failureCode };
  }

  private uncertain(failureCode: string, reference?: string): CustodyResult {
    return { status: "uncertain", provider: this.name, failureCode, ...(reference ? { reference } : {}) };
  }

  async transfer(request: CustodyTransfer): Promise<CustodyResult> {
    // Testnet has no wNEAR wallet here, so wNEAR stands for test NEAR. USDC has no test equivalent.
    if (request.asset !== WNEAR_ASSET) return this.fail("asset_not_on_testnet");
    let amount: string;
    try {
      amount = toAtomic(request.amount, 24).toString();
    } catch {
      return this.fail("invalid_amount");
    }

    const { apiUrl, apiKey, fetchFn = fetch, timeoutMs = 90_000 } = this.options;
    let status: number;
    let body: Record<string, any>;
    try {
      const response = await fetchFn(`${apiUrl}/wallet/v1/transfer`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-idempotency-key": request.idempotencyKey,
        },
        body: JSON.stringify({ to: request.to, amount }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      body = (await response.json().catch(() => ({}))) as Record<string, any>;
    } catch {
      return this.uncertain("custody_no_answer");
    }

    const reference = typeof body.request_id === "string" ? body.request_id : undefined;
    const txHash = body.tx_hash ?? body.result?.tx_hash;
    // The transaction is on-chain and reverted, so the money didn't move.
    if (status === 422) return { ...this.fail(String(body.error ?? "onchain_tx_failed")), ...(txHash ? { txHash } : {}) };
    if (NOTHING_MOVED.has(status)) return this.fail(String(body.error ?? `http_${status}`));
    if (status !== 200) return this.uncertain(`http_${status}`, reference);

    if (body.status === "success") {
      return { status: "executed", provider: this.name, ...(txHash ? { txHash } : {}), ...(reference ? { reference } : {}) };
    }
    if (body.status === "failed") return { ...this.fail("provider_failed"), ...(reference ? { reference } : {}) };
    // processing, needs_review, or something new: it may still pay, so it's never called failed.
    return this.uncertain(`provider_status_${body.status ?? "unknown"}`, reference);
  }
}
