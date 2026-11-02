import { Page } from "../components/parts";
import { useDashboard } from "../lib/dashboard";
import { assetLabel } from "../lib/format";

function Rule({ label, value }: { label: string; value: string }) {
  return (
    <li className="rule">
      <span>{label}</span>
      <span className="rule-value">{value}</span>
    </li>
  );
}

export function Policy() {
  const { policy, health, frozen } = useDashboard();
  const rules = policy?.policy;
  return (
    <Page>
      <header className="page-head">
        <h1 className="page-title">The rules your agents can't change.</h1>
        <p className="page-lead">These limits apply to every payment. This page only shows them: worker agents can't reach them, and no invoice can talk its way past them.</p>
      </header>
      <div className="policy-grid section">
        <section className="card">
          {rules ? (
            <ul className="rules">
              <Rule label="Most for one payment" value={rules.maxPerPayment} />
              <Rule label="Most in one day" value={rules.dailyBudget} />
              <Rule label="Ask you above" value={rules.approvalThreshold} />
              <Rule label="Allowed assets" value={rules.allowedAssets.map(assetLabel).join(", ")} />
              <Rule label="Payees you've never paid" value={rules.askForNewPayees ? "Ask you first" : "Checked, then paid"} />
              <Rule label="Native NEAR transfers" value={rules.nativeNearTransfers ? "On" : "Off"} />
              <Rule label="Payments right now" value={frozen ? "Frozen" : "Running"} />
            </ul>
          ) : (
            <p className="card-pad muted">Loading the rules.</p>
          )}
        </section>
        <div style={{ display: "grid", gap: 14 }}>
          <section className="card card-pad">
            <div className="tile-label">Who can spend</div>
            <p className="statement" style={{ marginTop: 8 }}>{policy?.whoCanSpend ?? "Wardy Agent only"}</p>
            <p className="note" style={{ marginTop: 10 }}>Worker agents hold no keys and no spend grant. To pay anyone, they have to ask, so they can't skip the check.</p>
          </section>
          <section className="card card-pad">
            <h2 className="block-title">Custody provider</h2>
            <dl className="facts">
              <dt>Provider</dt>
              <dd className="mono">{policy?.provider ?? health?.provider ?? ""}</dd>
              <dt>Mode</dt>
              <dd>{health?.mode === "offline" ? "Offline: a mock ledger, so no real money exists here" : health?.mode === "testnet" ? "NEAR testnet: free test tokens" : health?.mode === "live" ? "Live: real money" : ""}</dd>
              <dt>Owner</dt>
              <dd className="mono">{policy?.ownerId ?? ""}</dd>
            </dl>
            <p className="note" style={{ marginTop: 12 }}>Amounts are in the payment's own asset. The provider enforces limits, assets and budget. Wardy Agent alone checks who is being paid.</p>
          </section>
        </div>
      </div>
    </Page>
  );
}
