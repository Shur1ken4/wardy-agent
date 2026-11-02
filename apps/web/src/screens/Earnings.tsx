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
        <p className="page-lead">Other agents can pay Wardy Agent to check a payee before they pay. A check can never move money.</p>
      </header>
      <section className="tiles section" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }} aria-label="Earnings">
        <StatTile label="Checks sold" value={earned?.checksSold ?? 0} />
        <StatTile label="Price per check" value={<span className="tile-value-small">Not listed yet</span>} />
        <StatTile label="Free checks answered" value={stats?.checksForOthers ?? 0} sub={health?.mode === "offline" ? "Checks are free in offline mode" : "Checks are free until a listing is live"} />
        <StatTile dark label="Revenue" value={revenue.length === 0 ? "0" : revenue.map(({ currency, amount }) => `${amount} ${currency}`).join(" + ")} />
      </section>
      <section className="section card">
        {(earned?.checksSold ?? 0) === 0 ? (
          <Empty title="Nothing has been sold yet">
            <p>Wardy Agent isn't listed on the Agent Market yet, so this page shows zero instead of a made-up number. A sale will appear here once there is one.</p>
          </Empty>
        ) : null}
      </section>
    </Page>
  );
}
