import * as ed from "@noble/ed25519";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalJson } from "./canonical.js";
import { sha256Hex } from "./hash.js";
import type { Verdict } from "./types.js";

/** Public on purpose: offline demos need a key that works for everyone. The UI labels it as a test key. */
export const OFFLINE_TEST_SIGNING_KEY = sha256Hex("wardy-agent offline test key, public on purpose");

export function generateSigningKey(): string {
  return bytesToHex(ed.utils.randomSecretKey());
}

export async function publicKeyOf(signingKey: string): Promise<string> {
  return bytesToHex(await ed.getPublicKeyAsync(hexToBytes(signingKey)));
}

export type UnsignedVerdict = Omit<Verdict, "signature" | "wardyPublicKey">;

/**
 * What the signature covers: the decision and the exact payment. `execution` and `networkReportId` change
 * after the decision, and a report quotes this signature, so neither can be inside it. The audit chain
 * covers those later changes.
 */
function signedBytes(verdict: Omit<Verdict, "signature">): Uint8Array {
  const { execution: _execution, networkReportId: _networkReportId, ...signed } = verdict as Verdict;
  const { signature: _signature, ...payload } = signed;
  return utf8ToBytes(canonicalJson(payload));
}

export async function signVerdict(unsigned: UnsignedVerdict, signingKey: string): Promise<Verdict> {
  const withKey = { ...unsigned, wardyPublicKey: await publicKeyOf(signingKey) };
  const signature = await ed.signAsync(signedBytes(withKey), hexToBytes(signingKey));
  return { ...withKey, signature: bytesToHex(signature) };
}

/**
 * Checks the signature against the key the verdict names. That alone proves only that the verdict is
 * internally consistent, because anyone can sign with their own key. Pass `expectedPublicKey` to also prove
 * who signed it.
 */
export async function verifyVerdict(verdict: Verdict, expectedPublicKey?: string): Promise<boolean> {
  if (expectedPublicKey !== undefined && verdict.wardyPublicKey !== expectedPublicKey) return false;
  try {
    return await ed.verifyAsync(hexToBytes(verdict.signature), signedBytes(verdict), hexToBytes(verdict.wardyPublicKey), {
      zip215: false, // RFC 8032's stricter rules, so a signature has one valid form.
    });
  } catch {
    return false;
  }
}
