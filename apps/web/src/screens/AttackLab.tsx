// The Attack Lab, run on the API's mock ledgers. Scenarios finish in about a second, so rows are revealed one at a time
// to be readable. The rows themselves are the real results, and nothing here computes or rounds them.
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Chip, CountUp, DemoBadge, Empty, ErrorNote, Page } from "../components/parts";
import { runAttackLab } from "../lib/api";
import { useDashboard } from "../lib/dashboard";
import { assetLabel } from "../lib/format";
import { Link, withVerdict } from "../lib/router";

export interface LabStep {
  decision: "ALLOW" | "HOLD" | "BLOCK";
  verdictId: string;
  ownerDecision: string | null;
}

export interface LabScenario {
  id: string;
  title: string;
  setup: string;
  kind: "attack" | "honest";
  without: { lost: Record<string, string> };
  with: { steps: LabStep[]; lost: Record<string, string> };
}

interface LabTotals {
  lostWithout: Record<string, string>;
  lostWith: Record<string, string>;
  honestPassed: number;
  honestTotal: number;
  falseBlocks: number;
}

interface LabDone {
  holdout: string;
  aiSource: string;
  totals: LabTotals;
  holdoutTotals: LabTotals;
}

const REVEAL_MS = 240;

function Lost({ lost, animate = false }: { lost: Record<string, string>; animate?: boolean }) {
  const entries = Object.entries(lost);
  if (entries.length === 0) return <>0</>;
  return (
    <>
      {entries.map(([asset, amount], index) => (
        <span key={asset}>
          {index > 0 ? " + " : ""}
          {animate ? <CountUp value={amount} from={0} /> : amount} {assetLabel(asset)}
        </span>
      ))}
    </>
  );
}

export function ResultsTable({ rows }: { rows: LabScenario[] }) {
  return (
    <div className="table-box">
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>Scenario</th>
            <th>Lost without Wardy Agent</th>
            <th>With Wardy Agent</th>
            <th>Lost with it</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const lostWith = Object.keys(row.with.lost).length > 0;
            return (
              <motion.tr key={row.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: "easeOut" }}>
                <td className="mono">{row.id}</td>
                <td>
                  {row.title}
                  <div className="muted small">{row.setup}</div>
                </td>
                <td className="num"><Lost lost={row.without.lost} /></td>
                <td>
                  <div className="step-chips">
                    {row.with.steps.map((step, index) => (
                      <Link key={`${step.verdictId}-${index}`} to={withVerdict("/attack-lab", step.verdictId)} aria-label={`Open the ${step.decision} verdict`}>
                        <Chip decision={step.decision} />
                      </Link>
                    ))}
                  </div>
                  {row.with.steps.some((step) => step.ownerDecision) ? <div className="muted small" style={{ marginTop: 4 }}>The owner {row.with.steps.find((step) => step.ownerDecision)?.ownerDecision === "approve" ? "approves" : "rejects"}</div> : null}
                </td>
                <td className={lostWith ? "num lost" : "num"}><Lost lost={row.with.lost} /></td>
              </motion.tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Totals, taken from the run as they are. */
export function Totals({ totals }: { totals: LabTotals }) {
  return (
    <section className="totals" aria-label="Totals for the main set">
      <div className="tile">
        <div className="tile-label">Lost without Wardy Agent</div>
        <div className="tile-value tile-value-small"><Lost lost={totals.lostWithout} animate /></div>
      </div>
      <div className="tile tile-dark">
        <div className="tile-label">Lost with Wardy Agent</div>
        <div className="tile-value tile-value-small"><Lost lost={totals.lostWith} animate /></div>
      </div>
      <div className="tile">
        <div className="tile-label">Honest payments passed</div>
        <div className="tile-value tile-value-small"><CountUp value={totals.honestPassed} from={0} /> of {totals.honestTotal}</div>
      </div>
      <div className="tile">
        <div className="tile-label">False blocks</div>
        <div className="tile-value tile-value-small">{totals.falseBlocks}</div>
      </div>
    </section>
  );
}

export function AttackLab() {
  const { health } = useDashboard();
  const reduceMotion = useReducedMotion();
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [main, setMain] = useState<LabScenario[]>([]);
  const [holdout, setHoldout] = useState<LabScenario[]>([]);
  const [progress, setProgress] = useState({ index: 0, total: 0 });
  const [done, setDone] = useState<LabDone | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queue = useRef<(() => void)[]>([]);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);
  const abort = useRef<AbortController>(undefined);

  useEffect(
    () => () => {
      abort.current?.abort();
      clearInterval(timer.current);
    },
    [],
  );

  const run = () => {
    abort.current?.abort();
    clearInterval(timer.current);
    queue.current = [];
    setMain([]);
    setHoldout([]);
    setDone(null);
    setError(null);
    setProgress({ index: 0, total: 0 });
    setStatus("running");

    const controller = new AbortController();
    abort.current = controller;
    const step = () => queue.current.shift()?.();
    timer.current = setInterval(step, reduceMotion ? 1 : REVEAL_MS);

    runAttackLab(({ event, data }) => {
      if (event === "scenario") {
        const { set, index, total, result } = data as { set: "main" | "holdout"; index: number; total: number; result: LabScenario };
        queue.current.push(() => {
          setProgress({ index, total });
          (set === "main" ? setMain : setHoldout)((rows) => [...rows, result]);
        });
      } else if (event === "done") {
        queue.current.push(() => {
          setDone(data as LabDone);
          setStatus("done");
          clearInterval(timer.current);
        });
      } else if (event === "error") {
        queue.current.push(() => {
          setError((data as { message: string }).message);
          setStatus("error");
          clearInterval(timer.current);
        });
      }
    }, controller.signal).catch((caught: Error) => {
      if (controller.signal.aborted) return;
      setError(caught.message);
      setStatus("error");
      clearInterval(timer.current);
    });
  };

  const available = health?.demoTools === true;
  const fraction = progress.total === 0 ? 0 : progress.index / progress.total;

  return (
    <Page>
      <header className="page-head">
        <div className="hero-top">
          <p className="eyebrow">Attack Lab</p>
          {health?.mode === "offline" ? <DemoBadge /> : null}
        </div>
        <h1 className="page-title">The same agent and inbox, with and without Wardy Agent.</h1>
        <p className="page-lead">Replays real attack patterns against a gullible agent, on mock ledgers. Every result below comes from the run you start here.</p>
        <div className="hero-actions">
          <button type="button" className="btn btn-primary" disabled={!available || status === "running"} onClick={run}>
            {status === "running" ? "Running" : status === "done" ? "Run again" : "Run Attack Lab"}
          </button>
        </div>
      </header>

      {!available && health ? <p className="note section">The Attack Lab runs on mock ledgers, so this button only works in offline mode. Start with <code>npm run dev</code> and no <code>WARDY_MODE</code> set.</p> : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {status === "running" || status === "done" ? (
        <section className="section" aria-live="polite">
          <div className="progress-text">
            <span>{status === "done" ? "Finished" : `Scenario ${progress.index} of ${progress.total || "…"}`}</span>
          </div>
          <div className="progress">
            <motion.div className="progress-bar" initial={{ scaleX: 0 }} animate={{ scaleX: status === "done" ? 1 : fraction }} transition={{ duration: 0.2, ease: "easeOut" }} />
          </div>
        </section>
      ) : null}

      {done ? <div className="section"><Totals totals={done.totals} /></div> : null}

      {main.length > 0 ? (
        <section className="section">
          <div className="section-head"><h2 className="section-title">Main set</h2></div>
          <p className="note" style={{ marginBottom: 12 }}>Written alongside the rules, so this shows the rules work as designed. "Without" is a scripted agent that obeys everything: a worst case, not a measure of any real model.</p>
          <div className="card"><ResultsTable rows={main} /></div>
        </section>
      ) : null}

      {holdout.length > 0 ? (
        <section className="section">
          <div className="section-head"><h2 className="section-title">Holdout</h2></div>
          {done ? <p className="callout" style={{ marginBottom: 12 }}><strong>{done.holdout}</strong></p> : <p className="note" style={{ marginBottom: 12 }}>Written after the rules were frozen, and never tuned for.</p>}
          <div className="card"><ResultsTable rows={holdout} /></div>
        </section>
      ) : null}

      {done ? <p className="note section">Private AI: {done.aiSource}</p> : null}

      {status === "idle" && available ? (
        <section className="section card">
          <Empty title="Nothing has run yet">
            <p>Press <strong>Run Attack Lab</strong> to see each attack play out. It takes a few seconds, and nothing leaves this machine.</p>
          </Empty>
        </section>
      ) : null}
    </Page>
  );
}
