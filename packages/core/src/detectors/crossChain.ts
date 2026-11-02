// D5 format checks. Offline and deterministic: an address has to be able to exist on the chain it's being sent
// on. Funds sent across chains to the wrong format are usually gone for good.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { isEvmChain, isValidNearAccount, looksLikeSolanaAddress } from "../accounts.js";
import { makeSignal } from "../config.js";
import type { Chain, Signal } from "../types.js";

/** EIP-55: the capital letters in a mixed-case address encode a checksum of the address. */
export function hasValidEvmChecksum(address: string): boolean {
  const hex = address.slice(2);
  const hash = bytesToHex(keccak_256(utf8ToBytes(hex.toLowerCase())));
  for (let index = 0; index < hex.length; index += 1) {
    const character = hex[index] as string;
    if (!/[a-fA-F]/.test(character)) continue;
    const upper = Number.parseInt(hash[index] as string, 16) >= 8;
    if ((upper && character !== character.toUpperCase()) || (!upper && character !== character.toLowerCase())) return false;
  }
  return true;
}

function evmProblem(address: string): string | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return "not_an_evm_address";
  const hex = address.slice(2);
  const mixedCase = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
  return mixedCase && !hasValidEvmChecksum(address) ? "bad_checksum" : null;
}

export function crossChainSignals(request: { payee: string; chain: Chain }): Signal[] {
  const { payee, chain } = request;
  let problem: string | null;
  if (chain === "near") problem = isValidNearAccount(payee) ? null : "not_a_near_account";
  else if (chain === "solana") problem = looksLikeSolanaAddress(payee) ? null : "not_a_solana_address";
  else if (isEvmChain(chain)) problem = evmProblem(payee);
  else {
    return [makeSignal("CHAIN_NOT_CHECKED", `Wardy Agent can't check address formats on ${chain}.`, { chain })];
  }
  if (!problem) return [];
  return [
    makeSignal("CHAIN_ADDRESS_MISMATCH", `This address can't exist on ${chain}. Funds sent there could be lost for good.`, {
      chain,
      problem,
    }),
  ];
}
