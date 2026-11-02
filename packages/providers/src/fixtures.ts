import accounts from "../fixtures/accounts.json" with { type: "json" };
import type { MockAccount } from "./chain/mock.js";

/** Offline chain data. Every name is checked by `npm run check:fixtures` to be unregistered on mainnet. */
export const OFFLINE_ACCOUNTS: Readonly<Record<string, MockAccount>> = accounts;
