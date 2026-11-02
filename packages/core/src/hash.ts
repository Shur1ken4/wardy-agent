import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalJson } from "./canonical.js";
import type { PaymentRequest } from "./types.js";

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

/** Hash of the request without its context, so it can be shared without exposing what the agent read. */
export function hashRequest(request: PaymentRequest): string {
  const { context: _context, ...withoutContext } = request;
  return sha256Hex(canonicalJson(withoutContext));
}
