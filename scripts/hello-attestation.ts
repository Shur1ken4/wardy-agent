// `npm run hello:attestation`: checks NEAR AI Cloud's hardware evidence for our model, live, with a nonce we choose. It
// needs no key, sends no invoice and costs nothing, so anyone can run it. It proves 4 of the 8 checks. The other 4 tie a
// real answer to this evidence, so they need a chat: `npm run hello:ai`, with a key.
import { checkModelEvidence } from "@wardy-agent/providers";

const model = process.env.NEAR_AI_MODEL || "z-ai/glm-5.3-flash";
const result = await checkModelEvidence(model, process.env.NEAR_AI_CLOUD_BASE_URL ? { baseUrl: process.env.NEAR_AI_CLOUD_BASE_URL } : {});

console.log(`Model: ${model}`);
for (const report of result.reports) {
  console.log(`\nSigning address:  ${report.signingAddress}`);
  console.log(`TDX status:       ${report.tdxStatus}`);
  const line = (passed: boolean, what: string) => console.log(`  ${passed ? "PASS" : "FAIL"}  ${what}`);
  line(report.gpuVerified, "NVIDIA confirmed the GPU evidence, with our nonce");
  line(report.tdxQuoteVerified, "the Intel TDX quote verifies against Intel's collateral");
  line(report.reportBindsSigner, "the verified quote binds the signing address");
  line(report.reportBindsNonce, "the verified quote embeds our nonce, so the evidence is fresh");
}
for (const note of result.notes) console.log(`  note: ${note}`);
console.log(`\nHardware evidence verified: ${result.verified}`);
console.log("This doesn't show that a given answer came from this hardware. `npm run hello:ai` checks that, with a key.");
process.exit(result.verified ? 0 : 1);
