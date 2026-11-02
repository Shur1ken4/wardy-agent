// Checks a verdict's signature here in the browser, so a reader doesn't have to take the server's word for it.
import type { Verdict } from "@wardy-agent/core";
import { verifyVerdict } from "@wardy-agent/core/sign";

export interface SignatureCheck {
  valid: boolean;
  key: string;
  where: string;
}

/**
 * The key comes from the server, and the check happens here. Browsers only offer the crypto this needs on a secure page,
 * such as localhost, so anywhere else it says plainly that it's relying on the server.
 */
export async function checkSignature(verdict: Verdict, server: { valid: boolean; publicKey: string }, hasCrypto = Boolean(globalThis.crypto?.subtle)): Promise<SignatureCheck> {
  if (!hasCrypto) return { valid: server.valid, key: server.publicKey, where: "Checked by the server: this page isn't secure enough for the browser to do it" };
  return { valid: await verifyVerdict(verdict, server.publicKey), key: server.publicKey, where: "Checked in this browser" };
}
