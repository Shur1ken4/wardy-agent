import { type AccountFacts, type AccountFactsSource, isImplicitAccount } from "@wardy-agent/core";

export interface MockAccount {
  ageHours: number;
  txCount: number;
}

/** Offline chain data. Ages are relative to `now`, so fixtures don't go stale. Anything unlisted doesn't exist. */
export class MockChainData implements AccountFactsSource {
  constructor(
    private readonly accounts: Readonly<Record<string, MockAccount>>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getAccountFacts(accountId: string): Promise<AccountFacts> {
    const account = this.accounts[accountId];
    const implicit = isImplicitAccount(accountId);
    if (!account) return { accountId, available: true, exists: false, implicit, createdAt: null, txCount: null };
    return {
      accountId,
      available: true,
      exists: true,
      implicit,
      createdAt: new Date(this.now().getTime() - account.ageHours * 3_600_000).toISOString(),
      txCount: account.txCount,
    };
  }
}
