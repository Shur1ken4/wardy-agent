import { useEffect, useRef, useState } from "react";
import { saveCredential } from "../lib/api";
import { useDashboard } from "../lib/dashboard";
import { Link } from "../lib/router";
import { WardyShield } from "./WardyShield";

const NAV = [
  { to: "/", label: "Live checks" },
  { to: "/policy", label: "Policy" },
  { to: "/attack-lab", label: "Attack Lab" },
  { to: "/network", label: "Network" },
  { to: "/earnings", label: "Earnings" },
  { to: "/agents", label: "For agents" },
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

/** On a hosted server, a visitor in their sandbox can sign in with a NEAR wallet to get a real testnet agent. */
function SignInWithNear() {
  const { health, signedIn } = useDashboard();
  const [state, setState] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const ready = useRef<{ wallet: typeof import("../lib/wallet"); prepared?: import("../lib/wallet").SignInReady }>(undefined);
  const offered = Boolean(health?.hosted) && !signedIn;

  // Ready before the tap, and kept fresh, because a browser allows the wallet's popup only straight after one.
  useEffect(() => {
    if (!offered) return;
    let stopped = false;
    const prepare = () =>
      import("../lib/wallet")
        .then(async (wallet) => {
          const prepared = await wallet.prepareSignIn(ready.current?.prepared);
          if (!stopped) ready.current = { wallet, prepared };
        })
        .catch(() => undefined);
    void prepare();
    const timer = setInterval(() => void prepare(), 60_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [offered]);

  if (!offered) return null;
  return (
    <span className="sign-in-near">
      <button
        type="button"
        className="btn btn-freeze"
        disabled={state.busy}
        title="Signs a message with your NEAR wallet. It can't move money."
        onClick={() => {
          const current = ready.current;
          if (!current?.prepared) {
            setState({ busy: false, error: "The wallet is still loading. Try again in a moment." });
            return;
          }
          setState({ busy: true });
          current.wallet
            .signInWithNear(current.prepared)
            .then(({ sessionToken }) => {
              saveCredential(sessionToken);
              window.location.assign("/");
            })
            .catch((error: Error) => {
              const blocked = /popup/i.test(error.message);
              // Each challenge works once, so the next tap gets a fresh one.
              if (ready.current) ready.current.prepared = undefined;
              void current.wallet.prepareSignIn().then((prepared) => {
                if (ready.current) ready.current.prepared = prepared;
              }, () => undefined);
              setState({
                busy: false,
                error: blocked ? "Your browser blocked the wallet's window. Allow pop-ups for this site, then try again." : error.message || "Sign-in didn't finish. Nothing changed.",
              });
            });
        }}
      >
        {state.busy ? "Waiting for your wallet" : "Sign in with NEAR"}
      </button>
      {state.error ? <span className="note note-error" role="alert">{state.error}</span> : null}
    </span>
  );
}

export function Header({ path }: { path: string }) {
  const { health, reaction, policy, signedIn, signOut } = useDashboard();
  const nav = useRef<HTMLElement>(null);
  // On a phone the tabs scroll sideways, so the current one is brought into view.
  useEffect(() => {
    nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [path]);
  return (
    <header className="header">
      <div className="header-inner">
        <Link className="brand" to="/" aria-label="Wardy Agent, home">
          <WardyShield size={30} tone="light" reaction={reaction} followPointer />
          <span>
            <span className="brand-name">Wardy Agent</span>
            <span className="brand-tag">know-your-payee for AI agents</span>
          </span>
        </Link>
        <nav ref={nav} className="nav" aria-label="Main">
          {NAV.map(({ to, label }) => (
            <Link key={to} to={to} aria-current={path === to ? "page" : undefined}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="header-side">
          {health ? <span className="policy-chip">{policyChipText(health.mode, health.provider)}</span> : null}
          {policy ? <span className="owner">{policy.ownerId}</span> : null}
          {signedIn ? <button type="button" className="btn btn-freeze" onClick={signOut}>Sign out</button> : null}
          <SignInWithNear />
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
