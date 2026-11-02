import seed from "../data/known-payees.json" with { type: "json" };

/** Real NEAR services, each confirmed on-chain, that scammers would imitate. */
export const SEED_PAYEES: readonly string[] = seed;
