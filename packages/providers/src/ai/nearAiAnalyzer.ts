import { CONTEXT_SYSTEM_PROMPT, type ContextAnalysis, type ContextAnalyzer, parseAiFindings } from "@wardy-agent/core";
import { type NearAiOptions, privateChat } from "./nearAiCloud.js";

/** The private context check. Untrusted text goes only in the user message, and only to NEAR AI Cloud. */
export class NearAiContextAnalyzer implements ContextAnalyzer {
  constructor(private readonly options: NearAiOptions) {}

  async analyze(document: string): Promise<ContextAnalysis> {
    const result = await privateChat(
      [
        { role: "system", content: CONTEXT_SYSTEM_PROMPT },
        { role: "user", content: document },
      ],
      this.options,
    );
    return {
      findings: parseAiFindings(result.content),
      model: result.model,
      attested: result.attested,
      attestationRef: result.chatId ?? undefined,
      signatureKind: result.signatureKind,
      attestationLevel: result.attestationLevel,
      checks: result.checks,
    };
  }
}
