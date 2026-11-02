// A very small router: the address bar is the only state, so links and the back button just work.
import { type AnchorHTMLAttributes, type MouseEvent, useEffect, useState } from "react";

const listeners = new Set<() => void>();

export function navigate(to: string, options: { replace?: boolean } = {}) {
  if (options.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  for (const listener of listeners) listener();
}

export interface Location {
  path: string;
  search: URLSearchParams;
}

const current = (): Location => ({ path: window.location.pathname, search: new URLSearchParams(window.location.search) });

export function useLocation(): Location {
  const [location, setLocation] = useState(current);
  useEffect(() => {
    const update = () => setLocation(current());
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return location;
}

/** Keeps the browser's behaviour for new tabs and the like, and only handles a plain click. */
export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handle} {...rest} />;
}

/** The same page, with a verdict's detail open over it. */
export function withVerdict(path: string, verdictId: string | null): string {
  const url = new URL(path, "http://x");
  if (verdictId) url.searchParams.set("verdict", verdictId);
  else url.searchParams.delete("verdict");
  return `${url.pathname}${url.search}`;
}
