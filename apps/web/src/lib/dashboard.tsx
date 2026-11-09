// What every screen shares: who's signed in, the mode, the live feed, and the mascot's reaction to it.
import type { AnchorSummary, VerdictView } from "@wardy-agent/core";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Health, liveFeed, type Me, type PolicyView, OFFLINE_OWNER_CREDENTIAL, savedCredential, saveCredential, setApiCredential, type Stats } from "./api";

export interface MascotReaction {
  kind: "BLOCK" | "HOLD" | "ALLOW";
  /** Changes every time, so the same decision twice still reacts twice. */
  at: number;
}

export interface Hold {
  verdict: VerdictView;
  expiresAt: string;
}

export interface Dashboard {
  health: Health | null;
  /** Null until the API has answered. */
  apiError: string | null;
  needsCredential: boolean;
  signIn(credential: string): void;
  /** True only for a real owner's sign-in: the offline demo has nothing to sign out of. */
  signedIn: boolean;
  signOut(): void;
  signInError: string | null;
  /** On a hosted server: the signed-in account, or this visitor's sandbox. Null elsewhere. */
  account: Me | null;
  stats: Stats | null;
  policy: PolicyView | null;
  network: { anchor: AnchorSummary | null } | null;
  verdicts: VerdictView[];
  holds: Hold[];
  live: boolean;
  reaction: MascotReaction | null;
  frozen: boolean;
  setFrozen(frozen: boolean): Promise<void>;
  refresh(): Promise<void>;
}

export const DashboardContext = createContext<Dashboard | null>(null);

export function useDashboard(): Dashboard {
  const value = useContext(DashboardContext);
  if (!value) throw new Error("useDashboard needs a DashboardProvider.");
  return value;
}

const FEED_SIZE = 100;
const HIDDEN_REFRESH_MS = 30_000;

export function upsertVerdict(list: readonly VerdictView[], verdict: VerdictView): VerdictView[] {
  const index = list.findIndex((candidate) => candidate.verdictId === verdict.verdictId);
  if (index >= 0) return list.map((candidate, at) => (at === index ? { ...candidate, ...verdict } : candidate));
  return [verdict, ...list].slice(0, FEED_SIZE);
}

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [credential, setCredential] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [network, setNetwork] = useState<{ anchor: AnchorSummary | null } | null>(null);
  const [verdicts, setVerdicts] = useState<VerdictView[]>([]);
  const [holds, setHolds] = useState<Hold[]>([]);
  const [live, setLive] = useState(false);
  const [reaction, setReaction] = useState<MascotReaction | null>(null);
  const [frozen, setFrozenState] = useState(false);
  const [account, setAccount] = useState<Me | null>(null);
  const seen = useRef(new Set<string>());

  // It's public, so a visitor sees it before signing in.
  useEffect(() => {
    api.networkFeed(1).then(
      ({ anchor }) => setNetwork({ anchor }),
      () => undefined,
    );
  }, []);

  // So a payment waiting for you shows in the tab's title, even when you're in another tab.
  useEffect(() => {
    document.title = holds.length > 0 ? `(${holds.length}) Waiting for you · Wardy Agent` : "Wardy Agent";
  }, [holds.length]);

  const refresh = useCallback(async () => {
    const [nextStats, nextHolds, nextHealth, nextPolicy] = await Promise.all([api.stats(), api.approvals(), api.health(), api.policy()]);
    setAccount(nextHealth.hosted ? await api.me().catch(() => null) : null);
    setStats(nextStats);
    setPolicy(nextPolicy);
    setHolds(nextHolds.approvals as Hold[]);
    setHealth(nextHealth);
    setFrozenState(nextHealth.frozen);
  }, []);

  // Works out who we are as soon as the API answers. Offline uses the public demo credential.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const connect = async () => {
      try {
        let answer = await api.health();
        if (stopped) return;
        let known = answer.mode === "offline" && !answer.hosted ? OFFLINE_OWNER_CREDENTIAL : savedCredential();
        // A hosted server gives each visitor their own sandbox, kept for this tab, so nobody shares a demo. One the server
        // has since cleared away is replaced, rather than leaving the page locked.
        if (answer.hosted) {
          setApiCredential(known);
          const stillThere = known ? await api.stats().then(() => true, () => false) : false;
          if (!stillThere) {
            known = (await api.sandbox()).ownerToken;
            saveCredential(known);
            setApiCredential(known);
          }
          answer = await api.health();
          if (stopped) return;
        }
        // Before any state changes, because a child's effects run first and may call the API straight away.
        setApiCredential(known);
        setHealth(answer);
        setFrozenState(answer.frozen);
        setApiError(null);
        setCredential(known);
      } catch (error) {
        if (stopped) return;
        setApiError((error as Error).message);
        timer = setTimeout(connect, 2000);
      }
    };
    void connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  // Loads the owner's data, then follows the live feed while this tab is showing. A browser allows only six connections
  // to a site, and a feed holds one open, so a hidden tab or a page being left has to let go of it. Otherwise a few
  // reloads or open tabs would hang every page of the dashboard. A tab catches up when it's shown again.
  useEffect(() => {
    if (!credential) return;
    setApiCredential(credential);
    let feed: AbortController | null = null;
    let stopped = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshSoon = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void refresh().catch(() => undefined), 150);
    };

    const onEvent = ({ event, data }: { event: string; data: unknown }) => {
      if (event === "verdict") {
        const verdict = data as VerdictView;
        setVerdicts((list) => upsertVerdict(list, verdict));
        if (!seen.current.has(verdict.verdictId)) {
          seen.current.add(verdict.verdictId);
          setReaction({ kind: verdict.decision, at: Date.now() });
        }
        refreshSoon();
      } else if (event === "frozen") {
        setFrozenState((data as { frozen: boolean }).frozen);
      }
    };

    const load = async () => {
      const { verdicts: loaded } = await api.verdicts(FEED_SIZE);
      for (const verdict of loaded) seen.current.add(verdict.verdictId);
      setVerdicts(loaded);
      await refresh();
    };

    const follow = async (controller: AbortController) => {
      while (!controller.signal.aborted) {
        try {
          await liveFeed(onEvent, controller.signal, () => setLive(true));
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof ApiError && error.status === 401) return;
        }
        setLive(false);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    };

    const startFollowing = () => {
      if (feed || stopped) return;
      const controller = new AbortController();
      feed = controller;
      void follow(controller);
    };

    const stopFollowing = () => {
      feed?.abort();
      feed = null;
      setLive(false);
    };

    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        stopFollowing();
        return;
      }
      void load().catch(() => undefined);
      startFollowing();
    };

    // A hidden tab has no feed, so it looks now and then, to keep the title honest about what's waiting.
    const hiddenCheck = setInterval(() => {
      if (document.visibilityState !== "visible") void refresh().catch(() => undefined);
    }, HIDDEN_REFRESH_MS);

    // A page restored from the browser's back/forward cache has lost its feed, and its numbers are old.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) onVisibility();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", stopFollowing);
    window.addEventListener("pageshow", onPageShow);

    (async () => {
      try {
        await load();
        if (stopped) return;
        setSignInError(null);
        saveCredential(credential === OFFLINE_OWNER_CREDENTIAL ? null : credential);
        if (document.visibilityState === "visible") startFollowing();
      } catch (error) {
        if (stopped) return;
        if (error instanceof ApiError && error.status === 401) {
          setSignInError("That credential wasn't accepted.");
          saveCredential(null);
          setCredential(null);
        } else {
          setApiError((error as Error).message);
        }
      }
    })();

    return () => {
      stopped = true;
      stopFollowing();
      clearTimeout(refreshTimer);
      clearInterval(hiddenCheck);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", stopFollowing);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [credential, refresh]);

  const setFrozen = useCallback(async (next: boolean) => {
    const answer = await (next ? api.freeze() : api.unfreeze());
    setFrozenState(answer.frozen);
  }, []);

  const value = useMemo<Dashboard>(
    () => ({
      health,
      apiError,
      needsCredential: Boolean(health) && health?.mode !== "offline" && !credential,
      signIn: (next) => setCredential(next.trim() || null),
      signedIn: Boolean(health) && health?.mode !== "offline" && Boolean(credential),
      // A full reload, so nothing of the owner's history stays in this tab's memory. A hosted server ends the session too.
      signOut: () => {
        const ending = health?.hosted ? api.signOut().catch(() => undefined) : Promise.resolve();
        void ending.finally(() => {
          saveCredential(null);
          window.location.assign("/");
        });
      },
      signInError,
      account,
      stats,
      policy,
      network,
      verdicts,
      holds,
      live,
      reaction,
      frozen,
      setFrozen,
      refresh,
    }),
    [health, apiError, credential, signInError, account, stats, policy, network, verdicts, holds, live, reaction, frozen, setFrozen, refresh],
  );
  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}
