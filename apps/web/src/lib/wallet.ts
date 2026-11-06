// Sign in with a NEAR wallet (Meteor), by signing a one-time message. Nothing here can move money: a NEP-413 message is
// never a transaction. A browser opens a wallet popup only straight after a tap, so the wallet code and the server's
// challenge are made ready before the tap, and the tap itself goes straight to the wallet.
import { Buffer } from "buffer";
import { api } from "./api";

// The wallet libraries were written for Node too, and use its Buffer. This file loads only for sign-in, so only then.
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

// The same public RPC the rest of this project uses, so the page's CSP names one host.
const MAINNET = {
  networkId: "mainnet",
  nodeUrl: "https://free.rpc.fastnear.com",
  helperUrl: "https://helper.mainnet.near.org",
  explorerUrl: "https://near.rocks",
  indexerUrl: "https://api.kitwallet.app",
};
// The server's challenge lasts 5 minutes, so a ready one is replaced before then.
const CHALLENGE_MS = 4 * 60_000;

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
}

interface Ready {
  wallet: { signMessage(params: { message: string; recipient: string; nonce: never }): Promise<{ accountId: string; publicKey: string; signature: string } | void> };
  challenge: { message: string; recipient: string; nonce: string };
  at: number;
}

let walletReady: Promise<Ready["wallet"]> | undefined;

async function loadWallet(): Promise<Ready["wallet"]> {
  const [{ setupWalletSelector }, { setupMeteorWallet }] = await Promise.all([import("@near-wallet-selector/core"), import("@near-wallet-selector/meteor-wallet")]);
  const selector = await setupWalletSelector({ network: MAINNET as never, modules: [setupMeteorWallet()] });
  return (await selector.wallet("meteor-wallet")) as unknown as Ready["wallet"];
}

/** Loads the wallet and fetches a challenge, ahead of the tap. Safe to call again: it reuses what's still good. */
export async function prepareSignIn(previous?: Ready): Promise<Ready> {
  walletReady ??= loadWallet();
  const wallet = await walletReady;
  if (previous && Date.now() - previous.at < CHALLENGE_MS) return previous;
  return { wallet, challenge: await api.signInChallenge(), at: Date.now() };
}

/** Called right in the tap: the wallet asks which account, and signs. Returns the session the server gives back. */
export async function signInWithNear(ready: Ready): Promise<{ ownerId: string; sessionToken: string }> {
  const { wallet, challenge } = ready;
  const signed = await wallet.signMessage({ message: challenge.message, recipient: challenge.recipient, nonce: Buffer.from(fromBase64(challenge.nonce)) as never });
  if (!signed) throw new Error("The wallet didn't sign. Nothing changed.");
  return api.signInVerify({ accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: challenge.nonce });
}

export type SignInReady = Ready;
