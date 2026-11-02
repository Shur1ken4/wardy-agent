import { type AiFindings, type ContextAnalysis, type ContextAnalyzer, sha256Hex } from "@wardy-agent/core";

export const OFFLINE_MODEL = "offline-fixture";

/**
 * Offline stand-in for the private AI. It answers from stored findings, keyed by the sha256 of the document,
 * and always says it isn't attested, because no TEE was involved. Unknown text counts as an AI failure.
 */
export class MockContextAnalyzer implements ContextAnalyzer {
  constructor(private readonly fixtures: Readonly<Record<string, AiFindings>> = {}) {}

  async analyze(document: string): Promise<ContextAnalysis> {
    return {
      findings: this.fixtures[sha256Hex(document)] ?? null,
      model: OFFLINE_MODEL,
      attested: false,
      signatureKind: "none",
      attestationLevel: "none",
    };
  }
}
