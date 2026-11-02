export const WNEAR_ASSET = "nep141:wrap.near";
export const USDC_ASSET = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

const ALIASES: Record<string, string> = {
  wnear: WNEAR_ASSET,
  "wrap.near": WNEAR_ASSET,
  usdc: USDC_ASSET,
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": USDC_ASSET,
};

/**
 * Maps the names agents use to exact asset ids. Plain "near" deliberately has no alias: native NEAR transfers
 * skip the custody provider's rules, so they must never be treated as wNEAR.
 */
export function normalizeAsset(asset: string): string {
  return ALIASES[asset.toLowerCase()] ?? asset;
}
