import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { PaymentStream } from "../components/PaymentStream";
import { Chip, CountUp, DemoBadge, Empty, ErrorNote, Page, Payee, StatTile } from "../components/parts";
import { Spelled } from "../components/Spelled";
import { api } from "../lib/api";
import { type Hold, useDashboard } from "../lib/dashboard";
import { assetLabel, formatAmount, lookalikeSignal, payeeParts, shortHash, timeOf } from "../lib/format";
import { Link, navigate, withVerdict } from "../lib/router";
import type { VerdictView } from "@wardy-agent/core";

const TRAFFIC_SECONDS = 15;

/** The checkpoint, with the real data around it. Each new payment goes to the gate, and its name spells out below. */
export function StreamWithData() {
  const { verdicts, reaction, network } = useDashboard();
  const latest = verdicts[0];
  const lookalike = latest ? lookalikeSignal(latest.signals) : undefined;
  const parts = latest
    ? payeeParts(latest.payee, lookalike?.evidence.lookalikeOf as string | undefined, lookalike?.evidence.differingPositions)
    : payeeParts("wardy-agent");
  return (
    <div className="stream-panel">
      <PaymentStream
        signal={reaction ? { decision: reaction.kind, at: reaction.at } : null}
        leftLabel={
          <>
            <span className="eyebrow">Last check</span>
            {latest ? <span className="stream-value">{latest.decision} · {timeOf(latest.createdAt)}</span> : <span className="stream-value">Waiting for a payment</span>}
          </>
        }
        rightLabel={
          <>
            <span className="eyebrow">On NEAR testnet</span>
            {network?.anchor ? <a className="stream-value link" href={network.anchor.txUrl} target="_blank" rel="noreferrer">root {shortHash(network.anchor.root, 6)}</a> : <span className="stream-value">Nothing anchored yet</span>}
          </>
        }
      />
      <div className="stream-reading">
        <span className="eyebrow">{latest ? "Read just now" : "Reading every payee"}</span>
        <Spelled parts={parts} spellKey={latest?.verdictId ?? "idle"} />
        {latest ? <Chip decision={latest.decision} /> : null}
      </div>
    </div>
  );
}

/** Shows a dash until the numbers have really arrived, so nothing ever claims a zero it doesn't know. */
export function Tiles() {
  const { stats } = useDashboard();
  const count = (value: number | undefined) => (value === undefined ? "–" : <CountUp value={value} />);
  const saved = stats?.saved ?? [];
  const earned = stats?.earned.revenue ?? [];
  return (
    <section className="tiles" aria-label="Today at a glance">
      <StatTile label="Payments checked today" value={count(stats?.checkedToday)} />
      <StatTile label="Blocked" value={count(stats?.blockedToday)} />
      <StatTile label="Held for you" value={count(stats?.heldNow)} />
      <StatTile
        label="Saved from scams"
        value={
          !stats ? (
            "–"
          ) : saved.length === 0 ? (
            "0"
          ) : (
            <span className={saved.length > 1 ? "tile-value-small" : undefined}>
              {saved.map(({ asset, amount }, index) => (
                <span key={asset} style={{ display: "block" }}>
                  {index > 0 ? "+ " : ""}
                  <CountUp value={amount} /> {assetLabel(asset)}
                </span>
              ))}
            </span>
          )
        }
      />
      <StatTile
        dark
        label="Earned by Wardy Agent"
        value={!stats ? "–" : earned.length === 0 ? "0" : earned.map(({ currency, amount }) => `${amount} ${currency}`).join(" + ")}
        sub={!stats ? undefined : earned.length === 0 ? "Nothing sold yet" : `${stats.earned.checksSold} checks sold`}
      />
    </section>
  );
}

function HeldRow({ hold }: { hold: Hold }) {
  const [error, setError] = useState<string | null>(null);
  const review = async () => {
    try {
      const { approvalUrl } = await api.approvalLink(hold.verdict.verdictId);
      const url = new URL(approvalUrl);
      navigate(`${url.pathname}${url.hash}`);
    } catch (caught) {
      setError((caught as Error).message);
    }
  };
  return (
    <div className="hold">
      <div className="hold-text">
        <div className="hold-title">
          {formatAmount(hold.verdict.amount, hold.verdict.asset)} to <span className="mono">{hold.verdict.payee}</span>
        </div>
        <div className="hold-why">{hold.verdict.reasons[0]}</div>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </div>
      <button type="button" className="btn btn-primary" onClick={() => void review()}>Review</button>
    </div>
  );
}

function FeedRow({ verdict }: { verdict: VerdictView }) {
  const lookalike = lookalikeSignal(verdict.signals);
  return (
    <motion.li className="feed-item" layout="position" initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: "easeOut" }}>
      {verdict.decision === "BLOCK" ? <motion.span className="feed-pulse" aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: [0, 0.2, 0] }} transition={{ duration: 0.75, ease: "easeOut" }} /> : null}
      <Link className="feed-row" to={withVerdict("/", verdict.verdictId)}>
        <span className="feed-meta">
          <span className="feed-time">{timeOf(verdict.createdAt)}</span>
          <span className="feed-agent">{verdict.agentId ?? "another agent"}</span>
        </span>
        <span className="feed-payee">
          <Payee payee={verdict.payee} {...(lookalike ? { lookalikeOf: lookalike.evidence.lookalikeOf as string, positions: lookalike.evidence.differingPositions } : {})} />
        </span>
        <span className="feed-amount">{formatAmount(verdict.amount, verdict.asset)}</span>
        <span className="feed-chip"><Chip decision={verdict.decision} /></span>
        <span className="feed-why">{verdict.reasons[0] ?? "No concerns found."}</span>
      </Link>
    </motion.li>
  );
}

export function Live() {
  const { health, verdicts, holds, live, stats } = useDashboard();
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const instruments = useRef<HTMLDivElement>(null);
  const demo = health?.demoTools === true;

  useEffect(() => () => clearTimeout(stopTimer.current), []);

  const play = async () => {
    setError(null);
    setPlaying(true);
    try {
      await api.playTraffic();
      // The checkpoint and the feed sit below the hero, and that's where the payments are about to show up.
      instruments.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      stopTimer.current = setTimeout(() => setPlaying(false), TRAFFIC_SECONDS * 1000);
    } catch (caught) {
      setPlaying(false);
      setError((caught as Error).message);
    }
  };

  return (
    <Page>
      <section className="hero">
        <div className="hero-text">
          <div className="hero-top">
            {health?.mode === "offline" ? <DemoBadge /> : null}
            {health?.mode === "testnet" ? <span className="badge badge-plain">NEAR testnet</span> : null}
          </div>
          <h1 className="hero-title">Every payment your agents make is checked first.</h1>
          <p className="hero-lead">Your worker agents hold no keys and no spend grant. Only Wardy Agent can pay, after it checks who is being paid and why.</p>
          <div className="hero-actions">
            {demo ? (
              <button type="button" className="btn btn-primary" disabled={playing} onClick={() => void play()}>
                {playing ? "Playing demo traffic" : "Play demo traffic"}
              </button>
            ) : null}
            <Link className="btn btn-secondary" to="/agents">Connect an agent</Link>
          </div>
          {demo ? <p className="note hero-note">Real checks on made-up payments. Nothing leaves this machine.</p> : null}
          {error ? <ErrorNote>{error}</ErrorNote> : null}
        </div>
      </section>

      <div ref={instruments} className="instruments">
        <StreamWithData />
        <Tiles />
      </div>

      {holds.length > 0 ? (
        <section className="section" aria-label="Waiting for you">
          <div className="section-head"><h2 className="section-title">Waiting for you</h2></div>
          <div className="holds">
            {holds.map((hold) => <HeldRow key={hold.verdict.verdictId} hold={hold} />)}
          </div>
        </section>
      ) : null}

      <section className="section">
        <div className="section-head">
          <h2 className="section-title">Live checks</h2>
          <span className="section-side">
            {verdicts.length > 0 ? <span className="small muted">Click a row for the details</span> : null}
            <span className={live ? "live-dot" : "live-dot off"}>{live ? "Live" : "Connecting"}</span>
          </span>
        </div>
        <div className="card">
          {verdicts.length === 0 ? (
            <Empty title={stats ? "No payments checked yet" : "Connecting"}>
              {stats ? (
                demo ? <p>Press <strong>Play demo traffic</strong> above, or run the Attack Lab, to see Wardy Agent in action.</p> : <p>This fills in as soon as one of your agents asks to pay. To connect one, follow docs/MCP_SETUP.md.</p>
              ) : null}
            </Empty>
          ) : (
            <>
              <div className="feed-columns" aria-hidden="true">
                <span>Time</span><span>Agent</span><span>Payee</span><span>Amount</span><span>Verdict</span><span>Why</span>
              </div>
              <ul className="feed-list" aria-live="polite">
                <AnimatePresence initial={false}>
                  {verdicts.map((verdict) => <FeedRow key={verdict.verdictId} verdict={verdict} />)}
                </AnimatePresence>
              </ul>
            </>
          )}
        </div>
      </section>
    </Page>
  );
}
