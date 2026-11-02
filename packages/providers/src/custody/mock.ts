import { type CustodyProvider, type CustodyResult, type CustodyTransfer, formatDecimal, parseDecimal, sha256Hex } from "@wardy-agent/core";

/**
 * A local ledger that stands in for custody offline. It never touches a network. Its transaction hashes start
 * with `mock-` so they can't be mistaken for real ones.
 */
export class MockCustody implements CustodyProvider {
  readonly name = "mock";
  private readonly balances = new Map<string, bigint>();
  private readonly results = new Map<string, CustodyResult>();
  readonly transfers: CustodyTransfer[] = [];

  constructor(balances: Readonly<Record<string, string>> = {}) {
    for (const [asset, amount] of Object.entries(balances)) this.balances.set(asset, parseDecimal(amount));
  }

  async transfer(request: CustodyTransfer): Promise<CustodyResult> {
    // Replaying a key returns the first answer and moves nothing, the same promise a real provider makes.
    const previous = this.results.get(request.idempotencyKey);
    if (previous) return previous;
    const amount = parseDecimal(request.amount);
    const balance = this.balances.get(request.asset) ?? 0n;
    const result: CustodyResult =
      amount > balance
        ? { status: "failed", provider: this.name, failureCode: "insufficient_balance" }
        : { status: "executed", provider: this.name, txHash: `mock-${sha256Hex(request.idempotencyKey).slice(0, 32)}` };
    if (result.status === "executed") {
      this.balances.set(request.asset, balance - amount);
      this.transfers.push(request);
    }
    this.results.set(request.idempotencyKey, result);
    return result;
  }

  balance(asset: string): string {
    return formatDecimal(this.balances.get(asset) ?? 0n);
  }

  async balanceNearEquivalent(): Promise<number> {
    return 0; // Pretend money: the live-mode safety limit doesn't apply.
  }
}
