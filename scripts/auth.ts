// Sign in with a NEAR wallet, by signing a message (NEP-413, https://github.com/near/NEPs/blob/master/neps/nep-0413.md).
// The server hands out a one-time nonce, the wallet signs { message, nonce, recipient }, and the server checks the
// signature and then asks NEAR that the key really is a full-access key of that account. Nothing is stored but a hash
// of the session token, so a copy of the server's data opens no one's account.
import { createHash, randomBytes } from "node:crypto";
import * as ed from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import { z } from "zod";

/** NEP-413's prefix, 2^31 + 413, so a signed message can never also be a valid transaction. */
const NEP413_TAG = 2 ** 31 + 413;
export const SIGN_IN_MESSAGE = "Sign in to Wardy Agent";

const AccountId = z.string().min(2).max(64).regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "not a NEAR account name");
export const SignInBody = z.strictObject({
  accountId: AccountId,
  publicKey: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,50}$/, "an ed25519 public key"),
  signature: z.string().min(1).max(200),
  nonce: z.string().min(1).max(100),
});
export type SignInInput = z.infer<typeof SignInBody>;

export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInError";
  }
}

function borshString(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

/** The exact bytes a wallet signs for NEP-413: the SHA-256 of the tag and the Borsh-encoded payload. */
export function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  const tag = new Uint8Array(4);
  new DataView(tag.buffer).setUint32(0, NEP413_TAG, true);
  const parts = [tag, borshString(message), nonce, borshString(recipient), new Uint8Array([0])]; // No callbackUrl.
  const joined = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return sha256(joined);
}

export interface WalletSignInOptions {
  /** Who the signature is for: this server's host. A signature meant for another site doesn't work here. */
  recipient: string;
  fetchFn?: typeof fetch;
  rpc?: { mainnet: string; testnet: string };
  now?: () => number;
  nonceTtlMs?: number;
  sessionTtlMs?: number;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export class WalletSignIn {
  private readonly nonces = new Map<string, number>();
  private readonly sessions = new Map<string, { ownerId: string; expiresAt: number }>();

  constructor(private readonly options: WalletSignInOptions) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  /** A fresh nonce, good for one try within a few minutes. */
  challenge(): { message: string; recipient: string; nonce: string } {
    const now = this.now();
    for (const [nonce, expiresAt] of this.nonces) if (expiresAt <= now) this.nonces.delete(nonce);
    if (this.nonces.size > 10_000) throw new SignInError("Too many sign-ins are under way. Try again in a minute.");
    const nonce = base64.encode(randomBytes(32));
    this.nonces.set(nonce, now + (this.options.nonceTtlMs ?? 5 * 60_000));
    return { message: SIGN_IN_MESSAGE, recipient: this.options.recipient, nonce };
  }

  /** Checks the wallet's signature and the key's standing on NEAR, then opens a session. */
  async verify(input: SignInInput): Promise<{ ownerId: string; sessionToken: string; expiresAt: string }> {
    // Spent on the first try, right or wrong, so a signature can't be replayed or guessed at.
    const expiresAt = this.nonces.get(input.nonce);
    this.nonces.delete(input.nonce);
    if (!expiresAt || expiresAt <= this.now()) throw new SignInError("That sign-in request expired. Try again.");

    let signature: Uint8Array;
    let publicKey: Uint8Array;
    try {
      signature = base64.decode(input.signature);
      publicKey = base58.decode(input.publicKey.slice("ed25519:".length));
    } catch {
      throw new SignInError("The wallet's answer couldn't be read.");
    }
    if (publicKey.length !== 32 || signature.length !== 64) throw new SignInError("The wallet's answer couldn't be read.");
    const signed = nep413Hash(SIGN_IN_MESSAGE, base64.decode(input.nonce), this.options.recipient);
    if (!(await ed.verifyAsync(signature, signed, publicKey))) throw new SignInError("The signature doesn't match.");

    // A valid signature from a key the account doesn't hold, or holds only for one contract, isn't a sign-in.
    if (!(await this.isFullAccessKey(input.accountId, input.publicKey))) {
      throw new SignInError("That key isn't a full-access key of this account on NEAR.");
    }

    const sessionToken = randomBytes(32).toString("hex");
    const until = this.now() + (this.options.sessionTtlMs ?? 7 * 24 * 60 * 60_000);
    this.sessions.set(hashToken(sessionToken), { ownerId: input.accountId, expiresAt: until });
    return { ownerId: input.accountId, sessionToken, expiresAt: new Date(until).toISOString() };
  }

  private async isFullAccessKey(accountId: string, publicKey: string): Promise<boolean> {
    const rpc = this.options.rpc ?? { mainnet: "https://free.rpc.fastnear.com", testnet: "https://test.rpc.fastnear.com" };
    const url = accountId.endsWith(".testnet") ? rpc.testnet : rpc.mainnet;
    let body: { result?: { permission?: unknown }; error?: unknown };
    try {
      const response = await (this.options.fetchFn ?? fetch)(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "wardy-agent", method: "query", params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey } }),
        signal: AbortSignal.timeout(15_000),
      });
      body = (await response.json()) as typeof body;
    } catch {
      throw new SignInError("Couldn't ask NEAR about this account right now. Try again.");
    }
    return body.result?.permission === "FullAccess";
  }

  /** The account a session belongs to, while it lasts. */
  session(token: string): string | undefined {
    if (!token) return undefined;
    const session = this.sessions.get(hashToken(token));
    if (!session) return undefined;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(hashToken(token));
      return undefined;
    }
    return session.ownerId;
  }

  logout(token: string): void {
    this.sessions.delete(hashToken(token));
  }
}
