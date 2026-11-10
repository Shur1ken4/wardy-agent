// The owner's phone. Opened from a link carrying a one-time token, so it needs no sign-in, and shows only this payment.
import type { VerdictView } from "@wardy-agent/core";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { DecisionMark } from "../components/DecisionMark";
import { Chip, Payee } from "../components/parts";
import { WardyShield } from "../components/WardyShield";
import { api, ApiError } from "../lib/api";
import { approvalQuestion, executionWords, formatAmount, lookalikeSignal, shortHash, timeOf, txUrl } from "../lib/format";

const TOKEN_KEY = "wardy-agent-approval-";

/** On a server with many owners, the link also names whose payment it is. Read before the token clears the address. */
export function takeTenant(verdictId: string): string | undefined {
  const fromLink = new URLSearchParams(window.location.hash.slice(1)).get("t");
  try {
    if (fromLink) sessionStorage.setItem(`${TOKEN_KEY}${verdictId}-owner`, fromLink);
    return fromLink ?? sessionStorage.getItem(`${TOKEN_KEY}${verdictId}-owner`) ?? undefined;
  } catch {
    return fromLink ?? undefined;
  }
}

/** Takes the token out of the address bar, so it isn't left in history or a screenshot. A reload still works. */
export function takeToken(verdictId: string): string | null {
  const fromLink = new URLSearchParams(window.location.hash.slice(1)).get("token");
  try {
    if (fromLink) {
      sessionStorage.setItem(`${TOKEN_KEY}${verdictId}`, fromLink);
      history.replaceState(null, "", window.location.pathname);
      return fromLink;
    }
    return sessionStorage.getItem(`${TOKEN_KEY}${verdictId}`);
  } catch {
    return fromLink;
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="approve">
      <header className="approve-head">
        <WardyShield size={24} tone="light" />
        Wardy Agent
      </header>
      <motion.main className="approve-main" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: "easeOut" }}>
        {children}
      </motion.main>
    </div>
  );
}

function Message({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <section className="card approve-result">
      <h1 className="approve-result-title">{title}</h1>
      {children ? <p className="note" style={{ marginTop: 10 }}>{children}</p> : null}
    </section>
  );
}

/** Displays a held payment and the two choices. It decides nothing itself. */
export function HoldCard({ verdict, expiresAt, busy, mode, onDecide }: { verdict: VerdictView; expiresAt: string; busy: boolean; mode?: string | undefined; onDecide(action: "approve" | "reject"): void }) {
  const { headline, isRepeat, firstTx } = approvalQuestion(verdict);
  const firstTxLink = txUrl(mode, verdict.execution?.provider, firstTx);
  const lookalike = lookalikeSignal(verdict.signals);
  const [main, ...more] = verdict.reasons;
  return (
    <>
      <section className="card approve-card">
        <Chip decision="HOLD" large />
        <h1 className="approve-title">{headline}</h1>
        {main ? <p className="approve-why">{main}</p> : null}
        {more.length > 0 ? (
          <details className="approve-more">
            <summary>{more.length === 1 ? "One more reason" : `${more.length} more reasons`}</summary>
            <ul className="approve-reasons">
              {more.map((reason, index) => <li key={index}>{reason}</li>)}
            </ul>
          </details>
        ) : null}
        <dl className="facts approve-facts">
          <dt>Payee</dt>
          <dd><Payee payee={verdict.payee} {...(lookalike ? { lookalikeOf: lookalike.evidence.lookalikeOf as string, positions: lookalike.evidence.differingPositions } : {})} /></dd>
          <dt>Amount</dt>
          <dd>{formatAmount(verdict.amount, verdict.asset)}</dd>
          {verdict.agentId ? (<><dt>Asked by</dt><dd>{verdict.agentId}</dd></>) : null}
          {firstTx ? (
            <>
              <dt>First payment</dt>
              <dd className="mono">{firstTxLink ? <a className="link" href={firstTxLink} target="_blank" rel="noreferrer">{shortHash(firstTx)}</a> : shortHash(firstTx)}</dd>
            </>
          ) : null}
          <dt>Decide by</dt>
          <dd>{timeOf(expiresAt)}</dd>
        </dl>
      </section>
      {/* Each button wears the colour of what it does, green pays and orange refuses, so neither is tapped by mistake. */}
      <div className="approve-actions">
        <button type="button" className="btn btn-approve btn-block" disabled={busy} onClick={() => onDecide("approve")}>
          {isRepeat ? "Approve — pay again" : "Approve and pay"}
        </button>
        <button type="button" className="btn btn-reject btn-block" disabled={busy} onClick={() => onDecide("reject")}>
          {isRepeat ? "Reject — don't pay twice" : "Reject — don't pay"}
        </button>
      </div>
    </>
  );
}

export function Outcome({ verdict }: { verdict: VerdictView }) {
  const paid = verdict.execution?.status === "executed";
  const open = verdict.execution?.status === "pending_owner";
  return (
    <section className="card approve-result">
      {open ? <WardyShield size={44} tone="light" /> : <DecisionMark paid={paid} />}
      <h1 className="approve-result-title">{paid ? "Approved and paid" : open ? "Still waiting" : "Nothing was paid"}</h1>
      <p className="note" style={{ marginTop: 10 }}>
        {formatAmount(verdict.amount, verdict.asset)} to <span className="mono">{verdict.payee}</span>. {paid ? "" : executionWords(verdict.execution)}
      </p>
      {verdict.execution?.txHash ? <p className="note mono" style={{ marginTop: 10 }}>Transaction {shortHash(verdict.execution.txHash)}</p> : null}
      <p style={{ marginTop: 16 }}><a className="link" href="/">Open the dashboard</a></p>
    </section>
  );
}

type State =
  | { kind: "loading" }
  | { kind: "no-token" }
  | { kind: "bad-link" }
  | { kind: "error"; message: string }
  | { kind: "open"; verdict: VerdictView; expiresAt: string; note?: string }
  | { kind: "done"; verdict: VerdictView };

export function Approve({ verdictId }: { verdictId: string }) {
  const [tenant] = useState(() => takeTenant(verdictId));
  const [token] = useState(() => takeToken(verdictId));
  const [state, setState] = useState<State>(token ? { kind: "loading" } : { kind: "no-token" });
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<string | undefined>();
  const framed = window.top !== window.self;

  useEffect(() => {
    if (!token || framed) return;
    let stopped = false;
    api.health().then(
      (health) => {
        if (!stopped) setMode(health.mode);
      },
      () => undefined,
    );
    api.previewHold(verdictId, token, tenant).then(
      (answer) => {
        if (stopped) return;
        setState(answer.open ? { kind: "open", verdict: answer.verdict, expiresAt: answer.expiresAt } : { kind: "done", verdict: answer.verdict });
      },
      (caught: unknown) => {
        if (stopped) return;
        setState(caught instanceof ApiError && caught.status === 401 ? { kind: "bad-link" } : { kind: "error", message: (caught as Error).message });
      },
    );
    return () => {
      stopped = true;
    };
  }, [verdictId, token, tenant, framed]);

  const decide = async (action: "approve" | "reject") => {
    if (!token || state.kind !== "open") return;
    setBusy(true);
    try {
      setState({ kind: "done", verdict: await api.decideHold(verdictId, action, token, tenant) });
    } catch (caught) {
      // Frozen, for one: the payment is still waiting, so the choices stay on screen.
      setState({ ...state, note: (caught as Error).message });
    } finally {
      setBusy(false);
    }
  };

  // Another page can't wrap this one and trick the owner into tapping.
  if (framed) return <Shell><Message title="Open this link on its own">This page can't be shown inside another page.</Message></Shell>;

  return (
    <Shell>
      {state.kind === "loading" ? <p className="note">Loading the payment.</p> : null}
      {state.kind === "no-token" ? <Message title="This link isn't complete">Open the whole link you were sent. Nothing was paid.</Message> : null}
      {state.kind === "bad-link" ? <Message title="This link doesn't work any more">It may have expired, or a newer link may have replaced it. Nothing was paid because of it.</Message> : null}
      {state.kind === "error" ? <Message title="Couldn't load this payment">{state.message}</Message> : null}
      {state.kind === "open" ? <HoldCard verdict={state.verdict} expiresAt={state.expiresAt} busy={busy} mode={mode} onDecide={(action) => void decide(action)} /> : null}
      {state.kind === "open" && state.note ? <p className="note note-error" role="alert">{state.note}</p> : null}
      {state.kind === "done" ? <Outcome verdict={state.verdict} /> : null}
    </Shell>
  );
}
