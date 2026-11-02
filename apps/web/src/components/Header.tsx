import { useState } from "react";
import { useDashboard } from "../lib/dashboard";
import { Link } from "../lib/router";
import { WardyShield } from "./WardyShield";

const NAV = [
  { to: "/", label: "Live checks" },
  { to: "/policy", label: "Policy" },
  { to: "/attack-lab", label: "Attack Lab" },
  { to: "/network", label: "Network" },
  { to: "/earnings", label: "Earnings" },
];

/** Says what's true for this mode. Only live mode has a policy the owner really signed. */
export function policyChipText(mode: string | undefined, provider: string | undefined): string {
  if (!mode || !provider) return "";
  if (mode === "offline") return `Demo policy · ${provider} custody`;
  if (mode === "testnet") return `Test policy · ${provider}`;
  return `Policy signed · ${provider}`;
}

function FreezeButton() {
  const { frozen, setFrozen, needsCredential, health } = useDashboard();
  const [busy, setBusy] = useState(false);
  if (!health || needsCredential || frozen) return null;
  return (
    <button
      type="button"
      className="btn btn-freeze"
      disabled={busy}
      title="Stops all payments at once"
      onClick={() => {
        setBusy(true);
        void setFrozen(true).finally(() => setBusy(false));
      }}
    >
      Freeze
    </button>
  );
}

export function Header({ path }: { path: string }) {
  const { health, reaction, policy } = useDashboard();
  return (
    <header className="header">
      <div className="header-inner">
        <Link className="brand" to="/" aria-label="Wardy Agent, home">
          <WardyShield size={30} tone="light" reaction={reaction} />
          <span>
            <span className="brand-name">Wardy Agent</span>
            <span className="brand-tag">know-your-payee for AI agents</span>
          </span>
        </Link>
        <nav className="nav" aria-label="Main">
          {NAV.map(({ to, label }) => (
            <Link key={to} to={to} aria-current={path === to ? "page" : undefined}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="header-side">
          {health ? <span className="policy-chip">{policyChipText(health.mode, health.provider)}</span> : null}
          {policy ? <span className="owner">{policy.ownerId}</span> : null}
          <FreezeButton />
        </div>
      </div>
    </header>
  );
}

export function FrozenBar() {
  const { frozen, setFrozen, needsCredential } = useDashboard();
  const [busy, setBusy] = useState(false);
  if (!frozen) return null;
  return (
    <div className="frozen-bar" role="status">
      <div className="frozen-bar-inner">
        <span>All payments are frozen. Nothing can be paid.</span>
        {needsCredential ? null : (
          <button
            type="button"
            className="btn btn-on-orange"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void setFrozen(false).finally(() => setBusy(false));
            }}
          >
            Unfreeze
          </button>
        )}
      </div>
    </div>
  );
}
