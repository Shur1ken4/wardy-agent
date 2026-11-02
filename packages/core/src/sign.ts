import * as ed from "@noble/ed25519";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalJson } from "./canonical.js";
import { sha256Hex } from "./hash.js";
import type { PublicVerdict, Verdict } from "./types.js";

/** Public on purpose: offline demos need a key that works for everyone. The UI labels it as a test key. */
export const OFFLINE_TEST_SIGNING_KEY = sha256Hex("wardy-agent offline test key, public on purpose");

export function generateSigningKey(): string {
  return bytesToHex(ed.utils.randomSecretKey());
}

export async function publicKeyOf(signingKey: string): Promise<string> {
  return bytesToHex(await ed.getPublicKeyAsync(hexToBytes(signingKey)));
}

/** Signs a piece of text, such as a report's leaf. */
export async function signText(text: string, signingKey: string): Promise<string> {
  return bytesToHex(await ed.signAsync(utf8ToBytes(text), hexToBytes(signingKey)));
}

export async function verifyText(text: string, signature: string, publicKey: string): Promise<boolean> {
  try {
    return await ed.verifyAsync(hexToBytes(signature), utf8ToBytes(text), hexToBytes(publicKey), { zip215: false });
  } catch {
    return false;
  }
}

export type UnsignedVerdict = Omit<Verdict, "signature" | "wardyPublicKey">;

/**
 * What the signature covers: the decision and the exact payment, in two layers. The public layer is listed field by
 * field, so a display field added to a verdict later can't break verification. The private layer goes in as a hash, so
 * a public report can show the first and still prove the signature, without revealing the amount or the owner's payment
 * history. The private layer holds a random `requestId`, so its hash can't be guessed by trying amounts. `execution` and
 * `networkReportId` change after the decision, and a report quotes this signature, so neither can be in it; the audit
 * chain covers them.
 */
function publicPart(verdict: Omit<Verdict, "signature">): Omit<PublicVerdict, "signature"> {
  const { verdictId, mode, requestHash, payee, chain, decision, riskScore, wardyPublicKey, createdAt } = verdict;
  const { requestId, asset, amount, signals, reasons, ai } = verdict;
  const lookalikeOf = signals.find((signal) => signal.detector === "lookalike" && typeof signal.evidence.lookalikeOf === "string")?.evidence.lookalikeOf as string | undefined;
  return {
    verdictId,
    mode,
    requestHash,
    payee,
    chain,
    decision,
    riskScore,
    wardyPublicKey,
    createdAt,
    // KNOWN_PAYEE scores below zero, but stays visible: the signature has to say if a report's target was a real payee.
    codes: signals.filter((signal) => (signal.points > 0 && signal.detector !== "policy") || signal.code === "KNOWN_PAYEE").map((signal) => signal.code),
    ...(lookalikeOf ? { lookalikeOf } : {}),
    ...(ai?.attestationRef ? { attestationRef: ai.attestationRef } : {}),
    privateHash: sha256Hex(canonicalJson({ requestId, asset, amount, signals, reasons, ai })),
  };
}

const signedBytes = (part: Omit<PublicVerdict, "signature">): Uint8Array => utf8ToBytes(canonicalJson(part));

export function publicVerdictOf(verdict: Verdict): PublicVerdict {
  return { ...publicPart(verdict), signature: verdict.signature };
}

/** Checks a verdict from its public part alone. Pass `expectedPublicKey` to also prove who signed it. */
export async function verifyPublicVerdict(part: PublicVerdict, expectedPublicKey?: string): Promise<boolean> {
  if (expectedPublicKey !== undefined && part.wardyPublicKey !== expectedPublicKey) return false;
  try {
    const { signature, ...signed } = part;
    return await ed.verifyAsync(hexToBytes(signature), signedBytes(signed), hexToBytes(part.wardyPublicKey), {
      zip215: false, // RFC 8032's stricter rules, so a signature has one valid form.
    });
  } catch {
    return false;
  }
}

export async function signVerdict(unsigned: UnsignedVerdict, signingKey: string): Promise<Verdict> {
  const withKey = { ...unsigned, wardyPublicKey: await publicKeyOf(signingKey) };
  const signature = await ed.signAsync(signedBytes(publicPart(withKey)), hexToBytes(signingKey));
  return { ...withKey, signature: bytesToHex(signature) };
}

/**
 * Checks the signature against the key the verdict names. That alone proves only that the verdict is
 * internally consistent, because anyone can sign with their own key. Pass `expectedPublicKey` to also prove
 * who signed it.
 */
export async function verifyVerdict(verdict: Verdict, expectedPublicKey?: string): Promise<boolean> {
  try {
    return await verifyPublicVerdict(publicVerdictOf(verdict), expectedPublicKey);
  } catch {
    return false;
  }
}
