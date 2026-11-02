// Address rules. NEAR account ids allow only a-z 0-9 - _ . so lookalikes there are ASCII tricks.
const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const IMPLICIT_HEX = /^[0-9a-f]{64}$/;
const IMPLICIT_ETH = /^0x[0-9a-f]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const EVM_CHAINS = new Set(["ethereum", "base", "arbitrum", "optimism", "polygon", "bsc", "avalanche"]);

export function isEvmChain(chain: string): boolean {
  return EVM_CHAINS.has(chain);
}

export function isValidNearAccount(accountId: string): boolean {
  return accountId.length >= 2 && accountId.length <= 64 && NEAR_ACCOUNT.test(accountId);
}

/** Valid as soon as someone sends to it, so "not on-chain" doesn't mean "doesn't exist". */
export function isImplicitAccount(accountId: string): boolean {
  return IMPLICIT_HEX.test(accountId) || IMPLICIT_ETH.test(accountId);
}

export function looksLikeSolanaAddress(address: string): boolean {
  return SOLANA_ADDRESS.test(address);
}

/** An account id or address, as opposed to a business name such as "Acme Shop". */
export function looksLikeAddress(value: string): boolean {
  const text = value.trim();
  return (
    /^0x[0-9a-fA-F]{40}$/.test(text) ||
    IMPLICIT_HEX.test(text) ||
    (text.includes(".") && isValidNearAccount(text)) ||
    (looksLikeSolanaAddress(text) && /\d/.test(text) && /[A-Z]/.test(text))
  );
}
