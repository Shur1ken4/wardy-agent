// Private inference on NEAR AI Cloud, plus the checks that prove it ran in a TEE. `attested` is true only
// when every check passes. A failure lowers the level; it never throws away the answer or fakes a pass.
// Flow follows https://docs.near.ai/cloud/verification; reference code: nearai/nearai-cloud-verifier.
import { createHash, randomBytes } from "node:crypto";
import type { AttestationLevel, SignatureKind } from "@wardy-agent/core";
import { recoverMessageAddress } from "viem";

export type { AttestationLevel, SignatureKind };

const NRAS_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu";
/** Same statuses the official verifier accepts: OutOfDate means valid crypto on an older TCB baseline. */
const TDX_STATUS_OK = new Set(["UpToDate", "OutOfDate"]);

export interface NearAiOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** A signature lookup can miss briefly when several TEE nodes serve a model. */
  signatureRetries?: number;
  signatureRetryDelayMs?: number;
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface AttestationChecks {
  /** The signature recovers to the address the service named. */
  signatureValid: boolean;
  /** The signed text commits to our exact request, the exact response and the model we asked for. */
  signedTextMatches: boolean;
  /** Signed inside the model's TEE, not only by the gateway. */
  signedByModelTee: boolean;
  /** The signer is an address from the attestation report. */
  signerInReport: boolean;
  /** NVIDIA confirmed the GPU evidence, with our nonce. */
  gpuVerified: boolean;
  /** The Intel TDX quote verifies against Intel's collateral. */
  tdxQuoteVerified: boolean;
  /** The verified quote binds the signing address. */
  reportBindsSigner: boolean;
  /** The verified quote embeds our nonce, so the evidence is fresh. */
  reportBindsNonce: boolean;
}

export interface VerifiedChat {
  content: string | null;
  model: string;
  chatId: string | null;
  attested: boolean;
  attestationLevel: AttestationLevel;
  signatureKind: SignatureKind;
  signingAddress: string | null;
  tdxStatus: string | null;
  checks: AttestationChecks;
  /** Why a check failed, in plain words. Never contains the prompt or the answer. */
  notes: string[];
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function decodeJwtPayload(token: string): Record<string, any> {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("not a JWT");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

/** NRAS answers `[["JWT", overall], {"GPU-0": token, ...}]`. Checking only the overall result isn't enough. */
export function checkGpuAttestation(body: unknown, nonce: string, nowSecs: number): { passed: boolean; reason?: string } {
  const fail = (reason: string) => ({ passed: false, reason });
  if (!Array.isArray(body) || !Array.isArray(body[0]) || typeof body[0][1] !== "string") {
    return fail("unexpected NRAS response");
  }
  const overall = decodeJwtPayload(body[0][1]);
  if (overall["x-nvidia-overall-att-result"] !== true) return fail("NVIDIA overall result is not true");
  if (String(overall.eat_nonce).toLowerCase() !== nonce.toLowerCase()) return fail("GPU evidence has a different nonce");
  if (typeof overall.exp !== "number" || overall.exp <= nowSecs) return fail("NVIDIA token has expired");

  const gpuTokens = Object.entries((body[1] ?? {}) as Record<string, unknown>);
  if (gpuTokens.length === 0) return fail("no per-GPU evidence");
  for (const [name, token] of gpuTokens) {
    const gpu = decodeJwtPayload(String(token));
    if (gpu.secboot !== true) return fail(`${name}: secure boot is off`);
    if (gpu.dbgstat !== "disabled") return fail(`${name}: debug mode is not disabled`);
    if (gpu.measres !== "success") return fail(`${name}: measurements did not pass`);
    if (String(gpu.eat_nonce).toLowerCase() !== nonce.toLowerCase()) return fail(`${name}: different nonce`);
  }
  return { passed: true };
}

/** report_data is 64 bytes: the signing address right-padded to 32, then the raw 32-byte nonce. */
export function checkReportData(reportData: Uint8Array, signingAddress: string, nonce: string) {
  const address = Buffer.from(signingAddress.replace(/^0x/i, ""), "hex");
  if (address.length === 0 || address.length > 32) return { bindsSigner: false, bindsNonce: false };
  const expectedFirst = Buffer.concat([address, Buffer.alloc(32 - address.length)]);
  const data = Buffer.from(reportData);
  return {
    bindsSigner: data.subarray(0, 32).equals(expectedFirst),
    bindsNonce: data.subarray(32, 64).equals(Buffer.from(nonce, "hex")),
  };
}

/** `provider_tee` signs `<model>:<request sha256>:<response sha256>`; `gateway` signs only the two hashes. */
export function checkSignedText(
  text: string,
  expected: { model: string; requestHash: string; responseHash: string },
): { matches: boolean; kind: SignatureKind } {
  const hashesMatch = (requestHash?: string, responseHash?: string) =>
    requestHash === expected.requestHash && responseHash === expected.responseHash;
  // The model id can't contain the hashes, so read from the right.
  const parts = text.split(":");
  if (parts.length === 2) return { matches: hashesMatch(parts[0], parts[1]), kind: "gateway" };
  if (parts.length >= 3) {
    const model = parts.slice(0, -2).join(":");
    return {
      matches: model === expected.model && hashesMatch(parts.at(-2), parts.at(-1)),
      kind: "provider_tee",
    };
  }
  return { matches: false, kind: "none" };
}

export function summarize(checks: AttestationChecks): { attested: boolean; level: AttestationLevel } {
  const values = Object.values(checks);
  if (values.every(Boolean)) return { attested: true, level: "full" };
  return { attested: false, level: values.some(Boolean) ? "partial" : "none" };
}

export interface TdxResult {
  verified: boolean;
  status: string | null;
  reportData: Uint8Array | null;
  reason?: string;
}

/** Verifies a quote against the collateral given, or Intel's by default. Any failure means not verified. */
export async function verifyTdxQuote(quote: Uint8Array, nowSecs: number, collateral?: unknown): Promise<TdxResult> {
  try {
    // Loaded only here, so offline mode never pulls in the verifier.
    const qvl = await import("@phala/dcap-qvl");
    const evidence = (collateral ?? (await qvl.getCollateralFromPcs(quote))) as Parameters<typeof qvl.verify>[1];
    const { status, report } = qvl.verify(quote, evidence, nowSecs);
    const reportData =
      report.asTd10()?.reportData ??
      report.asTd15()?.base.reportData ??
      report.asTd15Ex()?.base.base.reportData ??
      null;
    if (!reportData) return { verified: false, status, reportData: null, reason: "quote is not a TDX report" };
    if (!TDX_STATUS_OK.has(status)) return { verified: false, status, reportData, reason: `TCB status is ${status}` };
    return { verified: true, status, reportData };
  } catch (error) {
    return { verified: false, status: null, reportData: null, reason: `quote rejected: ${(error as Error).message}` };
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ModelReport {
  signing_address?: string;
  intel_quote?: string;
  nvidia_payload?: string;
}

export async function privateChat(messages: ChatMessage[], options: NearAiOptions): Promise<VerifiedChat> {
  const { apiKey, model, fetchFn = fetch, timeoutMs = 60_000 } = options;
  const baseUrl = options.baseUrl ?? "https://cloud-api.near.ai/v1";
  const auth = { authorization: `Bearer ${apiKey}`, accept: "application/json" };
  const signal = () => AbortSignal.timeout(timeoutMs);
  const notes: string[] = [];
  const checks: AttestationChecks = {
    signatureValid: false,
    signedTextMatches: false,
    signedByModelTee: false,
    signerInReport: false,
    gpuVerified: false,
    tdxQuoteVerified: false,
    reportBindsSigner: false,
    reportBindsNonce: false,
  };

  // Attestation first, with a fresh nonce, so the evidence is from before the text is sent.
  const nonce = randomBytes(32).toString("hex");
  const query = new URLSearchParams({ model, provider: "near", signing_algo: "ecdsa", nonce });
  let reports: ModelReport[] = [];
  try {
    const response = await fetchFn(`${baseUrl}/attestation/report?${query}`, {
      headers: { ...auth, "x-no-aliasing": "true" },
      signal: signal(),
    });
    if (response.ok) reports = ((await response.json()) as { model_attestations?: ModelReport[] }).model_attestations ?? [];
    else notes.push(`attestation report answered HTTP ${response.status}`);
  } catch (error) {
    notes.push(`attestation report failed: ${(error as Error).name}`);
  }
  if (reports.length === 0) notes.push("no model attestation report for this model");

  // Non-streaming with the canonical model id: streaming and aliases fall back to gateway signatures.
  // The hash has to be over the exact bytes sent, so the body is serialised once.
  const requestBody = JSON.stringify({ model, messages, temperature: 0, stream: false });
  const chat = await fetchFn(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: requestBody,
    signal: signal(),
  });
  const responseText = await chat.text();
  if (!chat.ok) throw new Error(`NEAR AI Cloud answered HTTP ${chat.status}`);
  const parsed = JSON.parse(responseText) as { id?: string; choices?: { message?: { content?: string } }[] };
  const chatId = parsed.id ?? null;
  const content = parsed.choices?.[0]?.message?.content ?? null;

  let signatureKind: SignatureKind = "none";
  let signingAddress: string | null = null;
  let tdxStatus: string | null = null;

  const signature = chatId ? await fetchSignature(chatId, baseUrl, model, auth, options, notes) : null;
  if (signature) {
    const signed = checkSignedText(signature.text, {
      model,
      requestHash: sha256Hex(requestBody),
      responseHash: sha256Hex(responseText),
    });
    signatureKind = signature.signature_kind === "gateway" ? "gateway" : signed.kind;
    checks.signedTextMatches = signed.matches;
    checks.signedByModelTee = signatureKind === "provider_tee";
    if (!signed.matches) notes.push("signed text does not match this request and response");
    if (signatureKind === "gateway") notes.push("signed by the gateway TEE, not the model TEE");
    try {
      const recovered = await recoverMessageAddress({
        message: signature.text,
        signature: signature.signature as `0x${string}`,
      });
      signingAddress = recovered;
      checks.signatureValid = recovered.toLowerCase() === signature.signing_address.toLowerCase();
    } catch {
      notes.push("signature could not be recovered");
    }
  }

  const report = signingAddress
    ? reports.find((candidate) => candidate.signing_address?.toLowerCase() === signingAddress?.toLowerCase())
    : undefined;
  if (signingAddress && !report) notes.push("signer is not in the attestation report");
  if (report && signingAddress) {
    checks.signerInReport = true;
    const nowSecs = Math.floor(Date.now() / 1000);

    if (report.nvidia_payload) {
      try {
        const nras = await fetchFn(NRAS_URL, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: report.nvidia_payload,
          signal: signal(),
        });
        const gpu = checkGpuAttestation(await nras.json(), nonce, nowSecs);
        checks.gpuVerified = gpu.passed;
        if (gpu.reason) notes.push(`GPU check: ${gpu.reason}`);
      } catch (error) {
        notes.push(`GPU check failed: ${(error as Error).name}`);
      }
    } else {
      notes.push("report has no GPU evidence");
    }

    if (report.intel_quote) {
      const tdx = await verifyTdxQuote(Buffer.from(report.intel_quote, "hex"), nowSecs);
      tdxStatus = tdx.status;
      checks.tdxQuoteVerified = tdx.verified;
      if (tdx.reason) notes.push(`TDX check: ${tdx.reason}`);
      // Only a verified quote's report data counts.
      if (tdx.verified && tdx.reportData) {
        const bound = checkReportData(tdx.reportData, signingAddress, nonce);
        checks.reportBindsSigner = bound.bindsSigner;
        checks.reportBindsNonce = bound.bindsNonce;
        if (!bound.bindsSigner) notes.push("TDX report does not bind the signing address");
        if (!bound.bindsNonce) notes.push("TDX report does not embed our nonce");
      }
    } else {
      notes.push("report has no TDX quote");
    }
  }

  const { attested, level } = summarize(checks);
  return { content, model, chatId, attested, attestationLevel: level, signatureKind, signingAddress, tdxStatus, checks, notes };
}

interface ChatSignature {
  text: string;
  signature: string;
  signing_address: string;
  signature_kind?: string;
}

async function fetchSignature(
  chatId: string,
  baseUrl: string,
  model: string,
  auth: Record<string, string>,
  options: NearAiOptions,
  notes: string[],
): Promise<ChatSignature | null> {
  const { fetchFn = fetch, timeoutMs = 60_000, signatureRetries = 2, signatureRetryDelayMs = 1500 } = options;
  const query = new URLSearchParams({ model, signing_algo: "ecdsa" });
  for (let attempt = 0; attempt <= signatureRetries; attempt += 1) {
    if (attempt > 0) await sleep(signatureRetryDelayMs);
    try {
      const response = await fetchFn(`${baseUrl}/signature/${encodeURIComponent(chatId)}?${query}`, {
        headers: auth,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        const body = (await response.json()) as Partial<ChatSignature> & { error_code?: string };
        // A 2xx carrying error_code is "unavailable", not a signature.
        if (!body.error_code && body.text && body.signature && body.signing_address) return body as ChatSignature;
      }
    } catch {
      // Treated as a miss. The note below covers it.
    }
  }
  notes.push("chat signature unavailable after retries");
  return null;
}
