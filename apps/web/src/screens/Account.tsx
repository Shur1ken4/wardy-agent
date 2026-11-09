// A signed-in owner's own page on a hosted server: who they are, their agent, their limits, and how to get going.
import { Page } from "../components/parts";
import { agentWords, budgetShare, gettingStarted, type OwnerMe, spentOfBudget } from "../lib/account";
import { useDashboard } from "../lib/dashboard";
import { assetLabel } from "../lib/format";
import { Link } from "../lib/router";
import { HostedConnect } from "./Agents";

function NotSignedIn() {
  return (
    <Page>
      <header className="page-head">
        <p className="eyebrow">Your account</p>
        <h1 className="page-title">Sign in with NEAR to get an account.</h1>
        <p className="page-lead">
          You're in a demo sandbox: nothing real, and it's cleared after a while. Signing in gives you your own agent on NEAR testnet, with your own history and limits. Use the button at the top.
        </p>
      </header>
    </Page>
  );
}

function OwnerAccount({ account }: { account: OwnerMe }) {
  const { policy, stats, verdicts, signOut } = useDashboard();
  const rules = policy?.policy;
  const asset = assetLabel(rules?.allowedAssets[0] ?? "nep141:wrap.near");
  const spent = spentOfBudget(stats, rules);
  const share = rules ? budgetShare(spent, rules.dailyBudget) : 0;
  const agent = agentWords(account);
  const steps = gettingStarted(account, verdicts.length > 0 || (stats?.checkedToday ?? 0) > 0);

  return (
    <Page>
      <header className="page-head">
        <p className="eyebrow">Your account</p>
        <h1 className="page-title account-title">{account.ownerId}</h1>
        <p className="page-lead">
          On NEAR testnet, with free test tokens. Payments go out from a test wallet this server shares, and Wardy Agent holds each owner to their own limits below.
        </p>
      </header>

      <div className="agents-grid section">
        <div style={{ display: "grid", gap: 14 }}>
          <section className="card card-pad">
            <h2 className="block-title">Getting started</h2>
            <ol className="steps">
              {steps.map((step) => (
                <li key={step.title} className={step.done ? "step step-done" : "step"}>
                  <span className="step-mark" aria-hidden="true">{step.done ? "✓" : ""}</span>
                  <span>
                    <span className="step-title">{step.title}</span>
                    <span className="sr-only">{step.done ? " (done)" : " (to do)"}</span>
                    <span className="note">{step.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section className="card card-pad">
            <h2 className="block-title">Your agent</h2>
            <p className={`agent-state agent-${agent.state}`}>{agent.text}</p>
          </section>
          <HostedConnect />
        </div>

        <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
          <section className="card card-pad">
            <h2 className="block-title">Your limits</h2>
            {rules ? (
              <>
                <div className="budget" aria-label={`Spent ${spent} of ${rules.dailyBudget} ${asset} in the last 24 hours`}>
                  <div className="budget-numbers">
                    <span className="mono">{spent} of {rules.dailyBudget} {asset}</span>
                    <span className="note">spent in the last 24 hours</span>
                  </div>
                  <div className="budget-bar"><span style={{ width: `${Math.round(share * 100)}%` }} /></div>
                </div>
                <dl className="facts">
                  <dt>Most per payment</dt>
                  <dd className="mono">{rules.maxPerPayment} {asset}</dd>
                  <dt>Asks you above</dt>
                  <dd className="mono">{rules.approvalThreshold} {asset}</dd>
                  <dt>New payees</dt>
                  <dd>{rules.askForNewPayees ? "Asks you first" : "Checked, then paid"}</dd>
                  <dt>Pays to</dt>
                  <dd>.testnet accounts only</dd>
                </dl>
              </>
            ) : (
              <p className="note">Loading…</p>
            )}
          </section>

          <section className="card card-pad">
            <h2 className="block-title">Today</h2>
            <dl className="facts">
              <dt>Checked</dt>
              <dd className="mono">{stats?.checkedToday ?? 0}</dd>
              <dt>Paid</dt>
              <dd className="mono">{stats?.paidToday ?? 0}</dd>
              <dt>Waiting for you</dt>
              <dd className="mono">{stats?.heldNow ?? 0}</dd>
              <dt>Blocked</dt>
              <dd className="mono">{stats?.blockedToday ?? 0}</dd>
            </dl>
            <p className="note" style={{ marginTop: 12 }}>
              Each one is on <Link className="link" to="/">Live checks</Link>.
            </p>
          </section>

          <button type="button" className="btn btn-secondary" onClick={signOut}>Sign out</button>
        </div>
      </div>
    </Page>
  );
}

export function Account() {
  const { account } = useDashboard();
  return account?.kind === "owner" ? <OwnerAccount account={account} /> : <NotSignedIn />;
}
