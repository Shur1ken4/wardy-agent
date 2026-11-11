// What a verdict says, in plain words first. This part only displays: it fetches nothing and decides nothing.
import { ATTESTATION_CHECKS, type AttestationCheck, type AttestationChecks, type Signal, type VerdictAi, type VerdictView } from "@wardy-agent/core";
import type { ReactNode } from "react";
import { executionWords, formatAmount, lookalikeSignal, SEVERITY_WORDS, shortHash, timeOf, txUrl } from "../lib/format";
import { Payee } from "./parts";

function Compare({ verdict, signal }: { verdict: VerdictView; signal: Signal }) {
  const real = signal.evidence.lookalikeOf as string;
  const paid = signal.evidence.knownSource === "paid";
  const times = typeof signal.evidence.paidCount === "number" ? signal.evidence.paidCount : undefined;
  return (
    <section className="card card-pad" aria-label="The two names, side by side">
      <div className="compare">
        <div className="compare-side">
          <div className="compare-label">{paid ? `You paid before${times ? `, ${times} times` : ""}` : "The real name"}</div>
          <div className="compare-name mono">{real}</div>
        </div>
        <div className="compare-side">
          <div className="compare-label">Agent tried to pay</div>
          <div className="compare-name">
            <Payee payee={verdict.payee} lookalikeOf={real} positions={signal.evidence.differingPositions} sweep />
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Says exactly what was proven. A tick appears only when every attestation check passed, because a model answering isn't
 * the same as proof of where it ran.
 */
/** Each check in plain words, in the order they're made. */
export const CHECK_WORDS: Record<AttestationCheck, string> = {
  signatureValid: "The answer's signature matches the signer the service named",
  signedTextMatches: "The signed text is exactly our request, the answer, and the model we asked for",
  signedByModelTee: "Signed inside the model's TEE, not only by the gateway",
  signerInReport: "The signer is listed in the hardware attestation report",
  gpuVerified: "NVIDIA confirmed the GPU evidence, with our nonce",
  tdxQuoteVerified: "The Intel TDX quote verifies against Intel's collateral",
  reportBindsSigner: "The verified quote binds the signing address",
  reportBindsNonce: "The verified quote embeds our nonce, so the evidence is fresh",
};

/** The eight checks, each with its own tick or cross, when a live call recorded them. */
export function CheckList({ checks }: { checks: AttestationChecks }) {
  return (
    <ul className="check-list" aria-label="Attestation checks">
      {ATTESTATION_CHECKS.map((name) => (
        <li key={name} className={checks[name] ? "check-pass" : "check-fail"}>
          <span className={checks[name] ? "tick tick-good" : "tick tick-bad"} aria-hidden="true">{checks[name] ? "✓" : "✗"}</span>
          <span>{CHECK_WORDS[name]}</span>
        </li>
      ))}
    </ul>
  );
}

export function ReadPrivately({ ai }: { ai: VerdictAi | undefined }) {
  let body: ReactNode;
  if (ai?.attested) {
    body = (
      <>
        <p className="check-result">
          <span className="tick tick-good" aria-hidden="true">✓</span>
          <span>Read in a TEE on NEAR AI Cloud, with its attestation verified. Nobody else saw the text.</span>
        </p>
        <dl className="facts" style={{ marginTop: 12 }}>
          {ai.model ? (<><dt>Model</dt><dd className="mono">{ai.model}</dd></>) : null}
          {ai.attestationLevel ? (<><dt>Attestation</dt><dd>{ai.attestationLevel}</dd></>) : null}
          {ai.signatureKind ? (<><dt>Signed in</dt><dd>{ai.signatureKind === "provider_tee" ? "the model's TEE" : "the gateway's TEE"}</dd></>) : null}
          {ai.attestationRef ? (<><dt>Reference</dt><dd className="mono">{shortHash(ai.attestationRef, 16)}</dd></>) : null}
        </dl>
        {ai.checks ? <CheckList checks={ai.checks} /> : null}
      </>
    );
  } else if (ai?.used) {
    body = (
      <>
        <p className="check-result">
          <span className="tick tick-bad" aria-hidden="true">✗</span>
          <span>A model read this{ai.model ? ` (${ai.model})` : ""}, but its attestation isn't verified, so nothing here proves it stayed private. A recorded answer replayed offline always looks like this.</span>
        </p>
        {ai.checks ? <CheckList checks={ai.checks} /> : null}
      </>
    );
  } else {
    body = <p className="note">The private AI check didn't run for this payment, so only the built-in rules read the text. The decision stands without it.</p>;
  }
  return (
    <section className="card card-pad">
      <h3 className="block-title">Read privately</h3>
      {body}
    </section>
  );
}

export function VerdictDetail({ verdict, mode, children }: { verdict: VerdictView; mode: string | undefined; children?: ReactNode }) {
  const lookalike = lookalikeSignal(verdict.signals);
  const shown = verdict.signals.filter((signal) => signal.code !== "AI_UNAVAILABLE");
  const link = txUrl(mode, verdict.execution?.provider, verdict.execution?.txHash);
  const asker = verdict.mode === "check" ? "Another agent asked. Wardy Agent can't spend for it, so nothing could move." : undefined;
  return (
    <>
      <section>
        <p className="panel-why">{verdict.reasons[0] ?? "No concerns found."}</p>
        <div className="panel-facts">
          <span>{formatAmount(verdict.amount, verdict.asset)}</span>
          <Payee payee={verdict.payee} {...(lookalike ? { lookalikeOf: lookalike.evidence.lookalikeOf as string, positions: lookalike.evidence.differingPositions } : {})} />
          {verdict.agentId ? <span>{verdict.agentId}</span> : null}
          <span>{timeOf(verdict.createdAt)}</span>
        </div>
        {asker ? <p className="note" style={{ marginTop: 10 }}>{asker}</p> : null}
      </section>

      {lookalike ? <Compare verdict={verdict} signal={lookalike} /> : null}

      <section className="card card-pad">
        <h3 className="block-title">What Wardy Agent found</h3>
        {shown.length === 0 ? (
          <p className="note">Nothing unusual.</p>
        ) : (
          <ul className="signals">
            {shown.map((signal, index) => (
              <li key={`${signal.code}-${index}`} className="signal">
                <span className={`severity severity-${signal.severity}`}>{SEVERITY_WORDS[signal.severity] ?? signal.severity}</span>
                <span>{signal.message}</span>
              </li>
            ))}
          </ul>
        )}
        <details style={{ marginTop: 12 }}>
          <summary>Technical details</summary>
          <pre className="raw">{JSON.stringify(verdict.signals.map(({ code, points, evidence }) => ({ code, points, evidence })), null, 2)}</pre>
        </details>
      </section>

      <ReadPrivately ai={verdict.ai} />

      <section className="card card-pad">
        <h3 className="block-title">Payment</h3>
        <dl className="facts">
          <dt>Status</dt>
          <dd>{executionWords(verdict.execution)}</dd>
          {verdict.execution?.txHash ? (
            <>
              <dt>Transaction</dt>
              <dd>
                {link ? (
                  <a className="link mono" href={link} target="_blank" rel="noreferrer">{shortHash(verdict.execution.txHash)}</a>
                ) : (
                  <span className="mono">{shortHash(verdict.execution.txHash)} <span className="muted">(mock ledger)</span></span>
                )}
              </dd>
            </>
          ) : null}
        </dl>
      </section>

      {children}
    </>
  );
}
