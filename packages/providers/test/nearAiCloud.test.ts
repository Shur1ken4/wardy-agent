import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  type AttestationChecks,
  checkGpuAttestation,
  checkReportData,
  checkSignedText,
  decodeJwtPayload,
  privateChat,
  sha256Hex,
  summarize,
  verifyTdxQuote,
} from "../src/ai/nearAiCloud.js";

const NONCE = "ab".repeat(32);
const NOW = 1_800_000_000;

function jwt(claims: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.sig`;
}

const goodOverall = { "x-nvidia-overall-att-result": true, eat_nonce: NONCE, exp: NOW + 3600 };
const goodGpu = { secboot: true, dbgstat: "disabled", measres: "success", eat_nonce: NONCE };

function nras(overall: Record<string, unknown> = goodOverall, gpu: Record<string, unknown> = goodGpu) {
  return [["JWT", jwt(overall)], { "GPU-0": jwt(gpu) }];
}

describe("decodeJwtPayload", () => {
  it("reads the payload", () => {
    expect(decodeJwtPayload(jwt({ a: 1 }))).toEqual({ a: 1 });
  });

  it("rejects a string that is not a JWT", () => {
    expect(() => decodeJwtPayload("nope")).toThrow();
  });
});

describe("checkGpuAttestation", () => {
  it("passes good evidence", () => {
    expect(checkGpuAttestation(nras(), NONCE, NOW)).toEqual({ passed: true });
  });

  it("accepts a nonce in a different case", () => {
    expect(checkGpuAttestation(nras(), NONCE.toUpperCase(), NOW).passed).toBe(true);
  });

  it.each([
    ["overall result false", nras({ ...goodOverall, "x-nvidia-overall-att-result": false })],
    ["overall result is the string true", nras({ ...goodOverall, "x-nvidia-overall-att-result": "true" })],
    ["a replayed nonce", nras({ ...goodOverall, eat_nonce: "cd".repeat(32) })],
    ["an expired token", nras({ ...goodOverall, exp: NOW - 1 })],
    ["secure boot off", nras(goodOverall, { ...goodGpu, secboot: false })],
    ["debug mode on", nras(goodOverall, { ...goodGpu, dbgstat: "enabled" })],
    ["failed measurements", nras(goodOverall, { ...goodGpu, measres: "fail" })],
    ["a GPU token with a replayed nonce", nras(goodOverall, { ...goodGpu, eat_nonce: "cd".repeat(32) })],
    ["no per-GPU evidence", [["JWT", jwt(goodOverall)], {}]],
    ["a malformed response", { error: "bad" }],
  ])("fails on %s", (_name, body) => {
    expect(checkGpuAttestation(body, NONCE, NOW).passed).toBe(false);
  });
});

describe("checkReportData", () => {
  const address = `0x${"11".repeat(20)}`;
  const padded = Buffer.concat([Buffer.alloc(20, 0x11), Buffer.alloc(12)]);
  const nonceBytes = Buffer.from(NONCE, "hex");

  it("confirms a matching signer and nonce", () => {
    expect(checkReportData(Buffer.concat([padded, nonceBytes]), address, NONCE)).toEqual({
      bindsSigner: true,
      bindsNonce: true,
    });
  });

  it("catches a different signer", () => {
    const other = Buffer.concat([Buffer.alloc(20, 0x22), Buffer.alloc(12)]);
    expect(checkReportData(Buffer.concat([other, nonceBytes]), address, NONCE).bindsSigner).toBe(false);
  });

  it("catches a stale nonce", () => {
    expect(checkReportData(Buffer.concat([padded, Buffer.alloc(32, 0x99)]), address, NONCE).bindsNonce).toBe(false);
  });

  it("rejects an empty address", () => {
    expect(checkReportData(Buffer.alloc(64), "0x", NONCE).bindsSigner).toBe(false);
  });
});

describe("checkSignedText", () => {
  const expected = { model: "z-ai/glm-5.3-flash", requestHash: "aaa", responseHash: "bbb" };

  it("accepts a model TEE payload", () => {
    expect(checkSignedText("z-ai/glm-5.3-flash:aaa:bbb", expected)).toEqual({ matches: true, kind: "provider_tee" });
  });

  it("handles a model id that contains a colon", () => {
    const withColon = { ...expected, model: "org/model:v2" };
    expect(checkSignedText("org/model:v2:aaa:bbb", withColon).matches).toBe(true);
  });

  it("names a gateway payload as gateway", () => {
    expect(checkSignedText("aaa:bbb", expected)).toEqual({ matches: true, kind: "gateway" });
  });

  it.each([
    ["another model", "other/model:aaa:bbb"],
    ["another request", "z-ai/glm-5.3-flash:zzz:bbb"],
    ["another response", "z-ai/glm-5.3-flash:aaa:zzz"],
  ])("rejects %s", (_name, text) => {
    expect(checkSignedText(text, expected).matches).toBe(false);
  });

  it("rejects text with no structure", () => {
    expect(checkSignedText("garbage", expected)).toEqual({ matches: false, kind: "none" });
  });
});

describe("summarize", () => {
  const all: AttestationChecks = {
    signatureValid: true,
    signedTextMatches: true,
    signedByModelTee: true,
    signerInReport: true,
    gpuVerified: true,
    tdxQuoteVerified: true,
    reportBindsSigner: true,
    reportBindsNonce: true,
  };

  it("is full only when every check passes", () => {
    expect(summarize(all)).toEqual({ attested: true, level: "full" });
  });

  it.each(Object.keys(all) as (keyof AttestationChecks)[])("is not attested when %s fails", (key) => {
    expect(summarize({ ...all, [key]: false })).toEqual({ attested: false, level: "partial" });
  });

  it("is none when nothing passes", () => {
    const none = Object.fromEntries(Object.keys(all).map((key) => [key, false])) as unknown as AttestationChecks;
    expect(summarize(none)).toEqual({ attested: false, level: "none" });
  });
});

// Real TDX quote and collateral from Phala-Network/dcap-qvl `sample/` (MIT).
describe("verifyTdxQuote on a real quote", () => {
  const dir = new URL("./fixtures/dcap/", import.meta.url);
  const quote = readFileSync(new URL("tdx_quote", dir));
  const collateral = JSON.parse(readFileSync(new URL("tdx_quote_collateral.json", dir), "utf8"));
  const WITHIN_VALIDITY = Date.parse("2025-07-01T00:00:00Z") / 1000;

  it("verifies it and returns 64 bytes of report data", async () => {
    const result = await verifyTdxQuote(quote, WITHIN_VALIDITY, collateral);
    expect(result.verified).toBe(true);
    expect(result.reportData?.length).toBe(64);
  });

  it("rejects a quote with a tampered report", async () => {
    const tampered = Buffer.from(quote);
    tampered[600] = (tampered[600] ?? 0) ^ 0xff; // Inside report_data.
    expect((await verifyTdxQuote(tampered, WITHIN_VALIDITY, collateral)).verified).toBe(false);
  });

  // GHSA-796p-j2gh-9m2q: older dcap-qvl builds accepted forged QE Identity data. This must stay rejected.
  it("rejects forged QE Identity collateral", async () => {
    const forged = { ...collateral, qe_identity: collateral.qe_identity.replace('"version":2', '"version":3') };
    expect(forged.qe_identity).not.toBe(collateral.qe_identity);
    expect((await verifyTdxQuote(quote, WITHIN_VALIDITY, forged)).verified).toBe(false);
  });

  it("rejects expired collateral", async () => {
    const later = Date.parse("2026-11-02T00:00:00Z") / 1000;
    expect((await verifyTdxQuote(quote, later, collateral)).verified).toBe(false);
  });

  it("never throws on garbage", async () => {
    const result = await verifyTdxQuote(Buffer.from("not a quote"), WITHIN_VALIDITY, collateral);
    expect(result).toMatchObject({ verified: false, status: null, reportData: null });
  });
});

describe("privateChat", () => {
  const base = "https://ai.test/v1";
  const account = privateKeyToAccount(`0x${"42".repeat(32)}`);
  const completion = JSON.stringify({ id: "chat-1", choices: [{ message: { content: "{\"ok\":true}" } }] });
  const options = { apiKey: "test", model: "m/x", baseUrl: base, signatureRetryDelayMs: 0 };
  const messages = [{ role: "user" as const, content: "hi" }];

  /** Routes every call. `signText` builds the signed text from the exact request body it received. */
  function stubFetch(handlers: {
    report?: () => Response;
    signature?: (requestBody: string) => Promise<Response> | Response;
  }) {
    let requestBody = "";
    let signatureCalls = 0;
    const fetchFn = (async (input: string, init?: RequestInit) => {
      if (input.includes("/attestation/report")) {
        return handlers.report?.() ?? Response.json({ model_attestations: [] });
      }
      if (input.endsWith("/chat/completions")) {
        requestBody = String(init?.body);
        return new Response(completion);
      }
      if (input.includes("/signature/")) {
        signatureCalls += 1;
        return (await handlers.signature?.(requestBody)) ?? new Response("{}", { status: 404 });
      }
      throw new Error(`unexpected call to ${input}`);
    }) as unknown as typeof fetch;
    return { fetchFn, signatureCalls: () => signatureCalls };
  }

  async function signedBy(text: string, signer = account) {
    return Response.json({
      text,
      signature: await signer.signMessage({ message: text }),
      signing_address: signer.address,
      signature_kind: "provider_tee",
    });
  }

  it("still returns the answer, marked unverified, when no signature ever arrives", async () => {
    const { fetchFn, signatureCalls } = stubFetch({});
    const result = await privateChat(messages, { ...options, fetchFn });
    expect(result.content).toBe('{"ok":true}');
    expect(result.attested).toBe(false);
    expect(result.attestationLevel).toBe("none");
    expect(result.notes).toContain("chat signature unavailable after retries");
    expect(signatureCalls()).toBe(3);
  });

  it("treats a 2xx carrying error_code as no signature", async () => {
    const { fetchFn } = stubFetch({ signature: () => Response.json({ error_code: "x", message: "y" }) });
    const result = await privateChat(messages, { ...options, fetchFn });
    expect(result.signatureKind).toBe("none");
    expect(result.attested).toBe(false);
  });

  it("confirms a real signature over the exact bytes, but is not attested without a report", async () => {
    const { fetchFn } = stubFetch({
      signature: (body) => signedBy(`m/x:${sha256Hex(body)}:${sha256Hex(completion)}`),
    });
    const result = await privateChat(messages, { ...options, fetchFn });
    expect(result.checks).toMatchObject({ signatureValid: true, signedTextMatches: true, signedByModelTee: true });
    expect(result.signingAddress).toBe(account.address);
    expect(result.checks.signerInReport).toBe(false);
    expect(result.attested).toBe(false);
    expect(result.attestationLevel).toBe("partial");
  });

  it("catches a signature made over a different response", async () => {
    const { fetchFn } = stubFetch({
      signature: (body) => signedBy(`m/x:${sha256Hex(body)}:${sha256Hex("something else")}`),
    });
    const result = await privateChat(messages, { ...options, fetchFn });
    expect(result.checks.signatureValid).toBe(true);
    expect(result.checks.signedTextMatches).toBe(false);
  });

  it("catches a service that names one signer while another key signed", async () => {
    const impostor = privateKeyToAccount(`0x${"43".repeat(32)}`);
    const { fetchFn } = stubFetch({
      signature: async (body) => {
        const text = `m/x:${sha256Hex(body)}:${sha256Hex(completion)}`;
        return Response.json({
          text,
          signature: await impostor.signMessage({ message: text }),
          signing_address: account.address,
        });
      },
    });
    const result = await privateChat(messages, { ...options, fetchFn });
    expect(result.checks.signatureValid).toBe(false);
    expect(result.attested).toBe(false);
  });

  it("reports a gateway signature honestly", async () => {
    const { fetchFn } = stubFetch({
      signature: async (body) => {
        const text = `${sha256Hex(body)}:${sha256Hex(completion)}`;
        return Response.json({
          text,
          signature: await account.signMessage({ message: text }),
          signing_address: account.address,
          signature_kind: "gateway",
        });
      },
    });
    const result = await privateChat(messages, { ...options, fetchFn });
    expect(result.signatureKind).toBe("gateway");
    expect(result.checks.signedByModelTee).toBe(false);
    expect(result.attested).toBe(false);
  });

  it("flags a signer who isn't in the attestation report", async () => {
    const { fetchFn } = stubFetch({
      report: () => Response.json({ model_attestations: [{ signing_address: `0x${"99".repeat(20)}` }] }),
      signature: (body) => signedBy(`m/x:${sha256Hex(body)}:${sha256Hex(completion)}`),
    });
    const result = await privateChat(messages, { ...options, fetchFn });
    expect(result.checks.signerInReport).toBe(false);
    expect(result.notes).toContain("signer is not in the attestation report");
  });

  it("never puts the prompt or the answer in its notes", async () => {
    const { fetchFn } = stubFetch({});
    const secret = "INVOICE-SECRET-TEXT";
    const result = await privateChat([{ role: "user", content: secret }], { ...options, fetchFn });
    expect(JSON.stringify(result.notes)).not.toContain(secret);
    expect(JSON.stringify(result.notes)).not.toContain("ok");
  });

  it("throws when the chat itself fails", async () => {
    const fetchFn = (async (input: string) =>
      input.endsWith("/chat/completions")
        ? new Response("no", { status: 500 })
        : Response.json({ model_attestations: [] })) as unknown as typeof fetch;
    await expect(privateChat(messages, { ...options, fetchFn })).rejects.toThrow(/HTTP 500/);
  });
});
