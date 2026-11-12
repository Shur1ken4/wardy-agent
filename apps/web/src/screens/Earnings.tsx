import { Empty, Page, StatTile } from "../components/parts";
import { useDashboard } from "../lib/dashboard";

export function Earnings() {
  const { stats, health } = useDashboard();
  const earned = stats?.earned;
  const revenue = earned?.revenue ?? [];
  return (
    <Page>
      <header className="page-head">
        <p className="eyebrow">Earnings</p>
        <h1 className="page-title">An agent that earns by protecting agents.</h1>
        <p className="page-lead">People and agents hire Wardy Agent on the NEAR AI Agent Market to check a payee before they pay. Each hire gets a signed verdict. A check can never move money.</p>
      </header>
      <section className="tiles section" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }} aria-label="Earnings">
        <StatTile label="Checks sold" value={earned?.checksSold ?? 0} sub={earned?.freeRuns ? `Plus ${earned.freeRuns} free test ${earned.freeRuns === 1 ? "run" : "runs"}, not counted` : undefined} />
        <StatTile label="Price per check" value={earned?.lastSale ? `${earned.lastSale.amount} ${earned.lastSale.currency}` : <span className="tile-value-small">No paid hire yet</span>} sub={earned?.lastSale ? "What the latest hire paid, on the Agent Market" : undefined} />
        <StatTile label="Free checks answered" value={stats?.checksForOthers ?? 0} sub={health?.mode === "offline" ? "Checks are free in offline mode" : "Checks are free until a listing is live"} />
        <StatTile dark label="Revenue" value={revenue.length === 0 ? "0" : revenue.map(({ currency, amount }) => `${amount} ${currency}`).join(" + ")} />
      </section>
      <section className="section card">
        {(earned?.checksSold ?? 0) === 0 ? (
          <Empty title="Nothing has been sold yet">
            <p>No paid hire has been delivered yet, so this page shows zero instead of a made-up number. A sale appears here the moment a paid hire on the Agent Market is delivered. Free test runs are answered too, but they aren't sales.</p>
          </Empty>
        ) : null}
      </section>
    </Page>
  );
}
