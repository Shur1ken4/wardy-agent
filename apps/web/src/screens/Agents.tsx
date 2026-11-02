// For agents, and for the people connecting them. It shows the real thing: what an agent sends, and what it gets back.
import type { VerdictView } from "@wardy-agent/core";
import { type FormEvent, useState } from "react";
import { Chip, ErrorNote, Page } from "../components/parts";
import { api } from "../lib/api";
import { useDashboard } from "../lib/dashboard";

const CONNECT_COMMAND = "npm run mcp:config";

const NEXT_STEPS: [string, string][] = [
  ["done", "Paid. Don't send it again, even if something later says it failed."],
  ["wait_for_owner", "Nothing is paid yet. Don't retry. Call wardy_status later."],
  ["stop", "Refused. Don't retry it or look for another way to pay."],
  ["tell_owner", "Custody had a problem, and money may have moved. Don't retry. Tell the owner."],
];

const TOOLS: [string, string][] = [
  ["wardy_pay", "Ask to pay. It's the only way to send money."],
  ["wardy_status", "See what happened to a payment, such as what the owner decided."],
  ["wardy_check", "Check a payment without making it."],
  ["wardy_network_lookup", "Look up a payee in the Wardy Network."],
];

const EXAMPLES = [
  { payee: "acme-shop.near", note: "a payee the owner pays" },
  { payee: "g1obex-supply.near", note: "a lookalike" },
  { payee: "no-such-account-here.near", note: "doesn't exist" },
];

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="copy-line">
      <code>{text}</code>
      <button type="button" className="btn btn-secondary btn-small" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

function TryCheck() {
  const { policy } = useDashboard();
  const [payee, setPayee] = useState("g1obex-supply.near");
  const [amount, setAmount] = useState("1.5");
  const [asked, setAsked] = useState<Record<string, unknown> | null>(null);
  const [answer, setAnswer] = useState<VerdictView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const request = { requestId: crypto.randomUUID(), agentId: "try-it", ownerId: policy?.ownerId ?? "visitor", payee: payee.trim(), chain: "near", asset: "wNEAR", amount: amount.trim(), purpose: "Trying a check", createdAt: new Date().toISOString() };
    try {
      setAnswer(await api.check(request));
      setAsked(request);
    } catch (caught) {
      setAnswer(null);
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const shown = answer && { decision: answer.decision, nextStep: answer.nextStep, riskScore: answer.riskScore, reasons: answer.reasons, verdictId: answer.verdictId };
  return (
    <section className="card card-pad">
      <h2 className="block-title">Try a check</h2>
      <p className="note" style={{ marginBottom: 12 }}>This asks the real API, the way your agent would. A check can never move money.</p>
      <form className="try-form" onSubmit={(event) => void run(event)}>
        <label className="field">
          <span className="eyebrow">Payee</span>
          <input className="input" value={payee} onChange={(event) => setPayee(event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        </label>
        <label className="field field-small">
          <span className="eyebrow">Amount, wNEAR</span>
          <input className="input" value={amount} inputMode="decimal" onChange={(event) => setAmount(event.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy || !payee.trim() || !amount.trim()}>Check it</button>
      </form>
      <div className="examples">
        <span className="small muted">Try:</span>
        {EXAMPLES.map((example) => (
          <button key={example.payee} type="button" className="example" onClick={() => setPayee(example.payee)}>
            <span className="mono">{example.payee}</span> <span className="muted">{example.note}</span>
          </button>
        ))}
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {answer ? (
        <div className="try-answer" aria-live="polite">
          <p className="check-result"><Chip decision={answer.decision} /><span>{answer.reasons[0]}</span></p>
          <div className="try-columns">
            <div>
              <div className="eyebrow">Your agent sent</div>
              <pre className="raw">{JSON.stringify({ payee: asked?.payee, asset: asked?.asset, amount: asked?.amount, purpose: asked?.purpose }, null, 2)}</pre>
            </div>
            <div>
              <div className="eyebrow">It gets back</div>
              <pre className="raw">{JSON.stringify(shown, null, 2)}</pre>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function Agents() {
  return (
    <Page>
      <header className="page-head">
        <p className="eyebrow">For agents</p>
        <h1 className="page-title">Give your agent one way to pay, and make it the safe one.</h1>
        <p className="page-lead">Your agent gets four tools and no keys. It can ask to pay, but only Wardy Agent can send the money, so it can't be talked into skipping the check.</p>
      </header>

      <div className="agents-grid section">
        <div style={{ display: "grid", gap: 14 }}>
          <section className="card card-pad">
            <h2 className="block-title">Connect in one command</h2>
            <p className="note" style={{ marginBottom: 12 }}>While <code>npm run dev</code> is running, this prints the setup for Claude Code, Claude Desktop or any MCP client.</p>
            <CopyLine text={CONNECT_COMMAND} />
            <p className="note" style={{ marginTop: 12 }}>
              No MCP? Your agent can read <a className="link" href="/llms.txt" target="_blank" rel="noreferrer">llms.txt</a> and use plain HTTP.
            </p>
          </section>
          <section className="card card-pad">
            <h2 className="block-title">The tools</h2>
            <dl className="facts">
              {TOOLS.map(([name, what]) => (
                <div key={name} style={{ display: "contents" }}>
                  <dt className="mono">{name}</dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section className="card card-pad">
            <h2 className="block-title">What your agent does with the answer</h2>
            <p className="note" style={{ marginBottom: 12 }}>Every answer has a <code>nextStep</code>, so it never has to guess from the words.</p>
            <dl className="facts">
              {NEXT_STEPS.map(([name, what]) => (
                <div key={name} style={{ display: "contents" }}>
                  <dt className="mono">{name}</dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
        <TryCheck />
      </div>
    </Page>
  );
}
