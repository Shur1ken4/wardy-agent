import type { AnchorSummary, FeedEntry, PayeeLookup, VerdictView } from "@wardy-agent/core";
import { verifyMerkleProof } from "@wardy-agent/core/merkle";
import { motion } from "motion/react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Chip, Empty, ErrorNote, Page } from "../components/parts";
import { api, type OnChainRoot, readRootFromChain } from "../lib/api";
import { useDashboard } from "../lib/dashboard";
import { codeWords, dateTimeOf, shortHash } from "../lib/format";
import { Link, useLocation, withVerdict } from "../lib/router";

/** Checked here in the browser against the anchored root, instead of taking the server's word. */
export function proofHolds(result: PayeeLookup): boolean {
  if (!result.merkleProof || !result.anchoredRoot) return false;
  return verifyMerkleProof(result.merkleProof, { root: result.anchoredRoot.root, count: result.anchoredRoot.count });
}

function LookupResult({ payee, result }: { payee: string; result: PayeeLookup }) {
  const first = result.reports[0];
  if (!first) {
    return (
      <div style={{ marginTop: 16 }}>
        <p className="check-result"><span><strong className="mono">{payee}</strong> has no reports that count.</span></p>
        <p className="note" style={{ marginTop: 6 }}>That isn't proof it's safe. A payment to it still gets every other check.</p>
        {result.withdrawn.length > 0 ? <p className="note" style={{ marginTop: 6 }}>A report about this payee was withdrawn by its reporter on {dateTimeOf(result.withdrawn[0]?.revokedAt ?? "")}.</p> : null}
      </div>
    );
  }
  return (
    <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
      <p className="check-result">
        <Chip decision="BLOCK" />
        <span><strong className="mono">{payee}</strong> has signed evidence against it. Don't pay it.</span>
      </p>
      <div className="report-codes">{first.codes.map((code) => <span key={code}>{codeWords(code)}</span>)}</div>
      {first.evidence.lookalikeOf ? <p className="small muted">Imitates <span className="mono">{first.evidence.lookalikeOf}</span></p> : null}
      {result.merkleProof ? (
        <p className="check-result">
          <span className={proofHolds(result) ? "tick tick-good" : "tick tick-bad"} aria-hidden="true">{proofHolds(result) ? "✓" : "✗"}</span>
          <span>{proofHolds(result) ? "The proof checks out in this browser: this report is in the anchored feed." : "The proof doesn't match the anchored root, so don't rely on it."}</span>
        </p>
      ) : (
        <p className="note">Newer than the last anchor, so there's no on-chain proof yet.</p>
      )}
      {result.merkleProof ? (
        <details>
          <summary>The proof</summary>
          <pre className="raw">{JSON.stringify(result.merkleProof, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

function Search() {
  const { search } = useLocation();
  const fromLink = search.get("payee") ?? "";
  const [value, setValue] = useState(fromLink);
  const [result, setResult] = useState<{ payee: string; answer: PayeeLookup } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const look = useCallback(async (payee: string) => {
    setError(null);
    try {
      setResult({ payee, answer: await api.lookup(payee) });
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, []);

  useEffect(() => {
    if (fromLink) {
      setValue(fromLink);
      void look(fromLink);
    }
  }, [fromLink, look]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const payee = value.trim();
    if (payee) void look(payee);
  };

  return (
    <section className="card card-pad">
      <h2 className="block-title">Look up a payee</h2>
      <form className="search" onSubmit={submit}>
        <input className="input" aria-label="Payee account" placeholder="acme-sh0p.near" value={value} onChange={(event) => setValue(event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        <button type="submit" className="btn btn-primary" disabled={!value.trim()}>Look up</button>
      </form>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {result ? <LookupResult payee={result.payee} result={result.answer} /> : null}
    </section>
  );
}

function AnchorCard({ anchor }: { anchor: AnchorSummary | null }) {
  const [onChain, setOnChain] = useState<OnChainRoot | null | "unreachable">(null);
  const [checking, setChecking] = useState(false);
  if (!anchor) {
    return (
      <section className="card card-pad">
        <h2 className="block-title">Anchored on NEAR</h2>
        <p className="note">Nothing has been anchored yet.</p>
      </section>
    );
  }
  const check = async () => {
    setChecking(true);
    try {
      setOnChain(await readRootFromChain(anchor.contractId));
    } catch {
      setOnChain("unreachable");
    } finally {
      setChecking(false);
    }
  };
  return (
    <section className="card card-pad">
      <h2 className="block-title">Anchored on NEAR testnet</h2>
      <p className="root">{anchor.root}</p>
      <dl className="facts" style={{ marginTop: 12 }}>
        <dt>Covers</dt>
        <dd>{anchor.count} {anchor.count === 1 ? "entry" : "entries"} in the feed</dd>
        <dt>Block</dt>
        <dd className="mono">{anchor.blockHeight}</dd>
        <dt>Contract</dt>
        <dd className="mono">{anchor.contractId}</dd>
      </dl>
      <div className="row-actions" style={{ marginTop: 14 }}>
        <a className="btn btn-secondary" href={anchor.txUrl} target="_blank" rel="noreferrer">View on NEAR</a>
        <button type="button" className="btn btn-secondary" disabled={checking} onClick={() => void check()}>Check the contract</button>
      </div>
      {onChain === "unreachable" ? <p className="note" style={{ marginTop: 10 }}>Couldn't reach NEAR from here. The link above still works when you're online.</p> : null}
      {onChain && onChain !== "unreachable" ? (
        <p className="check-result" style={{ marginTop: 10 }}>
          <span className={onChain.root === anchor.root && onChain.count === anchor.count ? "tick tick-good" : "tick tick-bad"} aria-hidden="true">{onChain.root === anchor.root && onChain.count === anchor.count ? "✓" : "✗"}</span>
          <span>{onChain.root === anchor.root && onChain.count === anchor.count ? "Read just now from the contract: it holds this exact root." : `The contract holds a different root (${onChain.count} entries). This page may be out of date.`}</span>
        </p>
      ) : null}
      <p className="note" style={{ marginTop: 12 }}>An anchor shows a report existed and hasn't changed since. It doesn't show the report is true.</p>
    </section>
  );
}

/** Cause and effect: an earlier report, and the later request it stopped. Drawn from real verdicts only. */
function ProtectedFlow({ verdict, report }: { verdict: VerdictView; report: FeedEntry | undefined }) {
  return (
    <div className="flow">
      <div className="flow-node">
        <div className="flow-label">{report?.seed ? "Reported, seeded by Attack Lab" : "An earlier attack was reported"}</div>
        <span className="mono">{verdict.payee}</span>
      </div>
      <motion.div className="flow-line" aria-hidden="true" initial={{ scaleX: 0, scaleY: 1 }} whileInView={{ scaleX: 1 }} viewport={{ once: true }} transition={{ duration: 0.45, ease: "easeOut" }} />
      <div className="flow-node">
        <div className="flow-label">Later, {verdict.agentId ?? "another owner's agent"} asked to pay it</div>
        <Link className="link" to={withVerdict("/network", verdict.verdictId)} aria-label="Open this verdict"><Chip decision={verdict.decision} /></Link>
      </div>
    </div>
  );
}

function ReportRow({ report, onWithdraw, canWithdraw }: { report: FeedEntry; onWithdraw(id: string): void; canWithdraw: boolean }) {
  return (
    <li className="report">
      <div className="report-top">
        <span className="mono">{report.payee}</span>
        {report.seed ? <span className="badge badge-demo">Seeded by Attack Lab</span> : null}
        {report.ownerConfirmed ? <span className="badge badge-plain">Owner confirmed</span> : null}
        {report.revokedAt && !report.counts ? <span className="badge badge-plain">Withdrawn</span> : null}
        {!report.revokedAt && !report.counts ? <span className="badge badge-plain">Not counted</span> : null}
        {report.anchored ? <span className="badge badge-good">Anchored</span> : <span className="badge badge-plain">Not anchored yet</span>}
      </div>
      <div className="report-codes">{report.codes.map((code) => <span key={code}>{codeWords(code)}</span>)}</div>
      <p className="report-meta">
        {report.evidence.lookalikeOf ? <>Imitates <span className="mono">{report.evidence.lookalikeOf}</span>. </> : null}
        {report.seed ? null : <>{dateTimeOf(report.createdAt)}. </>}
        Reporter <span className="mono">{shortHash(report.reporter, 8)}</span>
      </p>
      {canWithdraw && !report.seed && report.counts ? (
        <button type="button" className="btn btn-secondary" style={{ marginTop: 10 }} onClick={() => onWithdraw(report.reportId)}>Withdraw this report</button>
      ) : null}
    </li>
  );
}

export function Network() {
  const { verdicts, needsCredential } = useDashboard();
  const [feed, setFeed] = useState<{ reports: FeedEntry[]; anchor: AnchorSummary | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setFeed(await api.networkFeed());
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, verdicts.length]);

  const protections = useMemo(
    () =>
      verdicts
        .filter((verdict) => verdict.signals.some((signal) => signal.code === "NETWORK_REPORTED_SCAM"))
        .slice(0, 3)
        .map((verdict) => ({
          verdict,
          report: feed?.reports.find((report) => report.reportId === verdict.signals.find((signal) => signal.code === "NETWORK_REPORTED_SCAM")?.evidence.reportId),
        })),
    [verdicts, feed],
  );

  const withdraw = async (reportId: string) => {
    setError(null);
    try {
      await api.revokeReport(reportId);
      await load();
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  const reports = feed?.reports ?? [];
  const seeded = reports.some((report) => report.seed);

  return (
    <Page>
      <header className="page-head">
        <h1 className="page-title">When one agent is attacked, every agent learns.</h1>
        <p className="page-lead">One report with signed evidence is enough, and nothing is counted, so a thousand fake reports weigh as much as none.</p>
      </header>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <div className="network-grid section">
        <Search />
        <AnchorCard anchor={feed?.anchor ?? null} />
      </div>

      {protections.length > 0 ? (
        <section className="section card card-pad">
          <h2 className="block-title">Protected by the network</h2>
          <div style={{ display: "grid", gap: 12 }}>
            {protections.map(({ verdict, report }) => <ProtectedFlow key={verdict.verdictId} verdict={verdict} report={report} />)}
          </div>
        </section>
      ) : null}

      <section className="section">
        <div className="section-head"><h2 className="section-title">Recent reports</h2></div>
        {seeded ? <p className="note" style={{ marginBottom: 12 }}>Seeded by Attack Lab during the hackathon: these are demo reports, about names checked to be unregistered, and they only count in offline mode.</p> : null}
        <div className="card">
          {reports.length === 0 ? (
            <Empty title="No reports yet"><p>A report appears when a payment is blocked on two independent kinds of evidence.</p></Empty>
          ) : (
            <ul className="report-list">
              {reports.map((report) => <ReportRow key={report.reportId} report={report} canWithdraw={!needsCredential} onWithdraw={(id) => void withdraw(id)} />)}
            </ul>
          )}
        </div>
      </section>
    </Page>
  );
}
