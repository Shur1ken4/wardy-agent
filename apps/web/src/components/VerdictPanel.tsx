// The side panel over any screen. It fetches what the detail shows, and holds the actions the owner can take.
import type { VerdictView } from "@wardy-agent/core";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type AuditView } from "../lib/api";
import { useDashboard } from "../lib/dashboard";
import { dateTimeOf, shortHash } from "../lib/format";
import { Link } from "../lib/router";
import { checkSignature, type SignatureCheck } from "../lib/verify";
import { Chip, ErrorNote } from "./parts";
import { VerdictDetail } from "./VerdictDetail";

function SignatureBox({ verdict }: { verdict: VerdictView }) {
  const [result, setResult] = useState<SignatureCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = async () => {
    setError(null);
    try {
      setResult(await checkSignature(verdict, await api.verify(verdict.verdictId)));
    } catch (caught) {
      setError((caught as Error).message);
    }
  };
  return (
    <section className="card card-pad">
      <h3 className="block-title">Signature</h3>
      {result ? (
        <p className="check-result">
          <span className={result.valid ? "tick tick-good" : "tick tick-bad"} aria-hidden="true">{result.valid ? "✓" : "✗"}</span>
          <span>
            {result.valid ? "Valid. This is exactly what Wardy Agent decided, and nothing has changed it." : "This signature doesn't verify, so don't trust this verdict."}{" "}
            <span className="muted">{result.where}, against key <span className="mono">{shortHash(result.key, 8)}</span>.</span>
          </span>
        </p>
      ) : (
        <button type="button" className="btn btn-secondary" onClick={() => void check()}>Verify</button>
      )}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </section>
  );
}

function NetworkBox({ verdict, inLedger, onChange }: { verdict: VerdictView; inLedger: boolean; onChange(next: VerdictView): void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reportedHere = verdict.networkReportId;
  const known = verdict.signals.some((signal) => signal.code === "NETWORK_REPORTED_SCAM");
  const networkLink = `/network?payee=${encodeURIComponent(verdict.payee)}`;
  const report = async () => {
    setBusy(true);
    setError(null);
    try {
      const { reportId } = await api.report(verdict.verdictId);
      onChange({ ...verdict, networkReportId: reportId });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };
  if (verdict.decision === "ALLOW" && !reportedHere) return null;
  return (
    <section className="card card-pad">
      <h3 className="block-title">Wardy Network</h3>
      {reportedHere ? (
        <p>Reported, so other agents are protected too. <Link className="link" to={networkLink}>See the report</Link></p>
      ) : known ? (
        <p>This payee was already reported. <Link className="link" to={networkLink}>See the report</Link></p>
      ) : inLedger ? (
        <>
          <p className="note" style={{ marginBottom: 12 }}>This stays private unless you report it. A report names this payee in public, so only do it if you're sure.</p>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void report()}>Report payee</button>
        </>
      ) : (
        <p className="note">This came from an Attack Lab run, on mock ledgers, so it isn't reported from here.</p>
      )}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </section>
  );
}

const ENTRY_WORDS: Record<string, string> = { verdict: "Verdict signed", execution: "Payment outcome", owner_action: "Owner decided", freeze: "Frozen", unfreeze: "Unfrozen" };

function AuditBox({ verdictId, inLedger }: { verdictId: string; inLedger: boolean }) {
  const [audit, setAudit] = useState<AuditView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setError(null);
    try {
      setAudit(await api.audit(verdictId));
    } catch (caught) {
      setError((caught as Error).message);
    }
  };
  return (
    <section className="card card-pad">
      <h3 className="block-title">Audit log</h3>
      {audit ? (
        <>
          <p className="check-result">
            <span className={audit.valid ? "tick tick-good" : "tick tick-bad"} aria-hidden="true">{audit.valid ? "✓" : "✗"}</span>
            <span>{audit.valid ? `The whole chain is intact: ${audit.entries} entries, ${audit.signaturesChecked} signatures checked.` : `The chain is broken at line ${audit.problem?.line}: ${audit.problem?.reason}`}</span>
          </p>
          {audit.records.length > 0 ? (
            <dl className="facts" style={{ marginTop: 12 }}>
              {[...audit.records].reverse().map((record) => (
                <div key={record.hash} style={{ display: "contents" }}>
                  <dt>{ENTRY_WORDS[record.entry.type] ?? record.entry.type}</dt>
                  <dd><span className="mono">{shortHash(record.hash, 8)}</span> <span className="muted">{dateTimeOf(record.entry.at)}</span></dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="note" style={{ marginTop: 10 }}>{inLedger ? "No entries for this verdict." : "Attack Lab verdicts have their own chain, in apps/attack-lab/results/audit.jsonl."}</p>
          )}
        </>
      ) : (
        <button type="button" className="btn btn-secondary" onClick={() => void load()}>View audit log</button>
      )}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </section>
  );
}

export function VerdictPanel({ verdictId, onClose }: { verdictId: string; onClose(): void }) {
  const { verdicts, health } = useDashboard();
  const fromFeed = verdicts.find((candidate) => candidate.verdictId === verdictId);
  const [fetched, setFetched] = useState<VerdictView | null>(null);
  const [overridden, setOverridden] = useState<VerdictView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (fromFeed) return;
    let stopped = false;
    api.verdict(verdictId).then(
      (answer) => {
        if (!stopped) setFetched(answer);
      },
      (caught: Error) => {
        if (!stopped) setError(caught.message);
      },
    );
    return () => {
      stopped = true;
    };
  }, [verdictId, fromFeed]);

  useEffect(() => {
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      // Tab stays inside the panel, as it would in any dialog, instead of wandering the page behind it.
      const focusable = [...(panel.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), summary") ?? [])];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const verdict = overridden ?? fromFeed ?? fetched;
  return (
    <>
      <motion.div className="scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} />
      <motion.aside ref={panel} className="panel" role="dialog" aria-modal="true" aria-label="Verdict details" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} transition={{ duration: 0.22, ease: "easeOut" }}>
        <div className="panel-head">
          {verdict ? (
            <>
              <Chip decision={verdict.decision} large />
              <span className="panel-score">Risk {verdict.riskScore} of 100</span>
            </>
          ) : null}
          <button ref={closeButton} type="button" className="btn btn-secondary panel-close" onClick={onClose}>Close</button>
        </div>
        <div className="panel-body">
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {verdict ? (
            <VerdictDetail verdict={verdict} mode={health?.mode}>
              <NetworkBox verdict={verdict} inLedger={Boolean(fromFeed)} onChange={setOverridden} />
              <SignatureBox verdict={verdict} />
              <AuditBox verdictId={verdictId} inLedger={Boolean(fromFeed)} />
            </VerdictDetail>
          ) : null}
        </div>
      </motion.aside>
    </>
  );
}
