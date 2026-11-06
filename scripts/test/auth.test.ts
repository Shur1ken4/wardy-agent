// Sign-in with a NEAR wallet. The wallet side is played by near-api-js's own NEP-413 signer, so the bytes are the real ones.
import { base64 } from "@scure/base";
import { KeyPair, KeyPairSigner } from "near-api-js";
import { describe, expect, it } from "vitest";
import { SIGN_IN_MESSAGE, SignInError, WalletSignIn } from "../auth.js";

const RECIPIENT = "wardy.example";

/** NEAR's answer for view_access_key, as chosen by each test. */
function rpc(permission: unknown) {
  const calls: unknown[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(permission === "missing" ? { error: { name: "HANDLER_ERROR" } } : { result: { permission } }));
  }) as typeof fetch;
  return { fetchFn, calls };
}

async function walletSigns(signIn: WalletSignIn, accountId = "alice.near", recipient = RECIPIENT) {
  const keyPair = KeyPair.fromRandom("ed25519");
  const { nonce } = signIn.challenge();
  const signed = await new KeyPairSigner(keyPair).signNep413Message(accountId, { message: SIGN_IN_MESSAGE, recipient, nonce: base64.decode(nonce) });
  return { accountId, publicKey: keyPair.getPublicKey().toString(), signature: base64.encode(signed.signature), nonce };
}

describe("wallet sign-in", () => {
  it("accepts a real NEP-413 signature from a full-access key, and opens a session for that account", async () => {
    const { fetchFn, calls } = rpc("FullAccess");
    const signIn = new WalletSignIn({ recipient: RECIPIENT, fetchFn });
    const input = await walletSigns(signIn);
    const session = await signIn.verify(input);
    expect(session.ownerId).toBe("alice.near");
    expect(signIn.session(session.sessionToken)).toBe("alice.near");
    expect(calls[0]).toMatchObject({ params: { request_type: "view_access_key", account_id: "alice.near", public_key: input.publicKey } });
  });

  it("refuses a key that's only allowed to call one contract, or isn't on the account", async () => {
    for (const permission of [{ FunctionCall: { receiver_id: "game.near" } }, "missing"]) {
      const signIn = new WalletSignIn({ recipient: RECIPIENT, fetchFn: rpc(permission).fetchFn });
      await expect(signIn.verify(await walletSigns(signIn))).rejects.toThrow(/full-access/);
    }
  });

  it("refuses a signature meant for another site", async () => {
    const signIn = new WalletSignIn({ recipient: RECIPIENT, fetchFn: rpc("FullAccess").fetchFn });
    await expect(signIn.verify(await walletSigns(signIn, "alice.near", "evil.example"))).rejects.toThrow(/doesn't match/);
  });

  it("refuses a signature for one account presented as another's", async () => {
    const signIn = new WalletSignIn({ recipient: RECIPIENT, fetchFn: rpc("FullAccess").fetchFn });
    const input = await walletSigns(signIn);
    const other = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    await expect(signIn.verify({ ...input, publicKey: other })).rejects.toThrow(/doesn't match/);
  });

  it("uses each nonce once, and only before it expires", async () => {
    let now = 0;
    const signIn = new WalletSignIn({ recipient: RECIPIENT, fetchFn: rpc("FullAccess").fetchFn, now: () => now, nonceTtlMs: 1000 });
    const input = await walletSigns(signIn);
    await signIn.verify(input);
    await expect(signIn.verify(input)).rejects.toBeInstanceOf(SignInError);
    const late = await walletSigns(signIn);
    now += 2000;
    await expect(signIn.verify(late)).rejects.toThrow(/expired/);
    await expect(signIn.verify({ ...late, nonce: base64.encode(new Uint8Array(32)) })).rejects.toThrow(/expired/);
  });

  it("asks testnet about a .testnet account", async () => {
    const { fetchFn } = rpc("FullAccess");
    const urls: string[] = [];
    const signIn = new WalletSignIn({ recipient: RECIPIENT, fetchFn: ((url: string, init: RequestInit) => (urls.push(url), fetchFn(url, init))) as typeof fetch });
    await signIn.verify(await walletSigns(signIn, "bob.testnet"));
    expect(urls[0]).toContain("test.rpc");
  });

  it("ends a session on sign-out or when it expires", async () => {
    let now = 0;
    const signIn = new WalletSignIn({ recipient: RECIPIENT, fetchFn: rpc("FullAccess").fetchFn, now: () => now, sessionTtlMs: 1000 });
    const first = await signIn.verify(await walletSigns(signIn));
    signIn.logout(first.sessionToken);
    expect(signIn.session(first.sessionToken)).toBeUndefined();
    const second = await signIn.verify(await walletSigns(signIn));
    now += 2000;
    expect(signIn.session(second.sessionToken)).toBeUndefined();
    expect(signIn.session("made-up")).toBeUndefined();
  });
});
