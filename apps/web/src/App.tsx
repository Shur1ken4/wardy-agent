import { AnimatePresence } from "motion/react";
import { BlockBackdrop } from "./components/BlockBackdrop";
import { Header, FrozenBar } from "./components/Header";
import { HoldAlert } from "./components/HoldAlert";
import { ErrorNote, Page } from "./components/parts";
import { VerdictPanel } from "./components/VerdictPanel";
import { DashboardProvider, useDashboard } from "./lib/dashboard";
import { useLocation, withVerdict, navigate } from "./lib/router";
import { Account } from "./screens/Account";
import { Agents } from "./screens/Agents";
import { Approve } from "./screens/Approve";
import { AttackLab } from "./screens/AttackLab";
import { Earnings } from "./screens/Earnings";
import { Live } from "./screens/Live";
import { Network } from "./screens/Network";
import { Policy } from "./screens/Policy";
import { SignIn } from "./screens/SignIn";

/** The Wardy Network and the guide for agents are public. Everything else is the owner's. */
const PUBLIC_PAGES = new Set(["/network", "/agents"]);
export const isLocked = (path: string, needsCredential: boolean): boolean => needsCredential && !PUBLIC_PAGES.has(path);

function NotFound() {
  return (
    <Page>
      <header className="page-head">
        <h1 className="page-title">There's nothing at this address.</h1>
        <p className="page-lead"><a className="link" href="/">Open the dashboard</a></p>
      </header>
    </Page>
  );
}

function Console() {
  const { path, search } = useLocation();
  const { apiError, needsCredential, reaction, frozen } = useDashboard();
  const openVerdict = search.get("verdict");
  const locked = isLocked(path, needsCredential);

  const screen = (() => {
    if (locked) return <SignIn />;
    switch (path) {
      case "/":
        return <Live />;
      case "/policy":
        return <Policy />;
      case "/attack-lab":
        return <AttackLab />;
      case "/network":
        return <Network />;
      case "/earnings":
        return <Earnings />;
      case "/agents":
        return <Agents />;
      case "/account":
        return <Account />;
      default:
        return <NotFound />;
    }
  })();

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <BlockBackdrop signal={reaction} dimmed={path !== "/" && !locked} frozen={frozen} />
      <Header path={path} />
      <FrozenBar />
      {apiError ? (
        <div className="page">
          <ErrorNote>{apiError}</ErrorNote>
        </div>
      ) : null}
      {screen}
      {locked ? null : <HoldAlert />}
      <AnimatePresence>
        {openVerdict && !locked ? (
          <VerdictPanel key={openVerdict} verdictId={openVerdict} onClose={() => navigate(`${withVerdict(`${path}${window.location.search}`, null)}`)} />
        ) : null}
      </AnimatePresence>
    </>
  );
}

export function App() {
  const { path } = useLocation();
  // The approval page has its own look, and needs nothing but the link it was opened with.
  const approving = /^\/approve\/([^/]+)$/.exec(path);
  if (approving) return <Approve verdictId={decodeURIComponent(approving[1] as string)} />;
  return (
    <DashboardProvider>
      <Console />
    </DashboardProvider>
  );
}
