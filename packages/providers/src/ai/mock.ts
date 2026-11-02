import { type AiFindings, type AttestationLevel, type ContextAnalysis, type ContextAnalyzer, sha256Hex } from "@wardy-agent/core";

export const OFFLINE_MODEL = "offline-fixture";

/** One real answer from NEAR AI Cloud, kept so demos can replay it with no key. */
export interface RecordedFinding {
  findings: AiFindings;
  model: string;
  recordedAt: string;
  chatId: string | null;
  attested: boolean;
  attestationLevel: AttestationLevel;
}

function isRecorded(value: AiFindings | RecordedFinding): value is RecordedFinding {
  return "findings" in value;
}

/**
 * Offline stand-in for the private AI. It answers from stored findings, keyed by the sha256 of the document, and
 * always says it isn't attested, even when replaying an attested recording: no TEE ran for this answer. Unknown text
 * counts as an AI failure, never as all clear.
 */
export class MockContextAnalyzer implements ContextAnalyzer {
  constructor(private readonly fixtures: Readonly<Record<string, AiFindings | RecordedFinding>> = {}) {}

  async analyze(document: string): Promise<ContextAnalysis> {
    const fixture = this.fixtures[sha256Hex(document)];
    const recorded = fixture && isRecorded(fixture) ? fixture : null;
    return {
      findings: recorded ? recorded.findings : ((fixture as AiFindings | undefined) ?? null),
      model: recorded ? `${OFFLINE_MODEL} (recorded from ${recorded.model})` : OFFLINE_MODEL,
      attested: false,
      signatureKind: "none",
      attestationLevel: "none",
      ...(recorded?.chatId ? { attestationRef: recorded.chatId } : {}),
    };
  }
}
