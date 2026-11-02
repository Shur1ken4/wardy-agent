import { KeyPair, type KeyPairString } from "near-api-js";
import { describe, expect, it } from "vitest";
import { findSecrets, isForbiddenPath } from "../check-secrets.mjs";
import { fillEnv, generateNearKey } from "../setup-keys.js";

describe("generateNearKey", () => {
  it("produces a key near-api-js accepts, with the matching implicit account id", () => {
    const { accountId, privateKey } = generateNearKey();
    const pair = KeyPair.fromString(privateKey as KeyPairString);
    expect(accountId).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(pair.getPublicKey().data).toString("hex")).toBe(accountId);
  });

  it("never repeats a key", () => {
    expect(generateNearKey().privateKey).not.toBe(generateNearKey().privateKey);
  });
});

describe("fillEnv", () => {
  it("fills an empty value and leaves other lines alone", () => {
    expect(fillEnv("# note\nA=\nB=keep\n", { A: "1" })).toBe("# note\nA=1\nB=keep\n");
  });

  it("refuses to replace a value that is already set", () => {
    expect(() => fillEnv("A=old\n", { A: "new" })).toThrow(/already set/);
  });

  it("refuses a name that is not in the file", () => {
    expect(() => fillEnv("A=\n", { B: "1" })).toThrow(/missing/);
  });

  it("stores values containing dollar signs literally", () => {
    expect(fillEnv("A=\n", { A: "x$&y" })).toBe("A=x$&y\n");
  });
});

describe("findSecrets", () => {
  // Built at runtime so this test file never contains a string that trips the scanner.
  const fake = (prefix: string, length = 40) => prefix + "a1B2".repeat(length).slice(0, length);

  it.each([
    ["NEAR private key", fake("ed25519:", 88)],
    ["Agent Connect API key", fake("naa_")],
    ["Agent Connect grant token", fake("ngt_")],
    ["OutLayer wallet key", fake("wk_")],
    ["Agent Market token", fake("aat_")],
    ["API secret key", fake("sk-")],
    ["Telegram bot token", `123456789:${fake("", 35)}`],
    ["PEM private key", ["-----BEGIN", "PRIVATE KEY-----"].join(" ")],
  ])("flags a %s", (label, value) => {
    expect(findSecrets(`KEY=${value}\n`)).toContain(label);
  });

  it.each([
    "NEAR_INTENTS_AGENT_API_KEY=naa___",
    "uses a key (`naa_...`) from the dashboard",
    `public key ${fake("ed25519:", 44)}`,
    "sk-short",
  ])("does not flag %s", (text) => {
    expect(findSecrets(text)).toEqual([]);
  });
});

describe("isForbiddenPath", () => {
  it.each([".env", ".env.local", "apps/api/.env", "apps/api/.env.production"])("blocks %s", (path) => {
    expect(isForbiddenPath(path)).toBe(true);
  });

  it.each([".env.example", "docs/.env.example", "environment.ts", "src/env.ts"])("allows %s", (path) => {
    expect(isForbiddenPath(path)).toBe(false);
  });
});
