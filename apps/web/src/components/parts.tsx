// Small pieces every screen uses.
import type { Decision } from "@wardy-agent/core";
import { animate, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { payeeParts } from "../lib/format";

export function Chip({ decision, large = false }: { decision: Decision; large?: boolean }) {
  return (
    <motion.span className={`chip chip-${decision.toLowerCase()}${large ? " chip-large" : ""}`} initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.18, ease: "easeOut" }}>
      {decision}
    </motion.span>
  );
}

/** Account names go in mono, with the characters that give a lookalike away marked. React escapes all of it. */
export function Payee({ payee, lookalikeOf, positions, sweep = false }: { payee: string; lookalikeOf?: string | undefined; positions?: unknown; sweep?: boolean }) {
  return (
    <span className="mono payee" title={payee}>
      {payeeParts(payee, lookalikeOf, positions).map((part, index) =>
        part.differs ? (
          <mark key={index} className={sweep ? "diff diff-sweep" : "diff"}>
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}

const COUNT_SECONDS = 0.5;
const decimalsIn = (text: string): number => text.split(".")[1]?.length ?? 0;

/**
 * A number that counts to its new value. The exact text always wins in the end: a background tab can stall animation
 * frames for as long as it likes, and a security console must not sit on a wrong number while that happens.
 */
export function CountUp({ value, from }: { value: string | number; from?: number }) {
  const text = String(value);
  const target = Number(text);
  const reduceMotion = useReducedMotion();
  const previous = useRef(from ?? target);
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    const start = previous.current;
    previous.current = target;
    if (reduceMotion || !Number.isFinite(target) || start === target || document.visibilityState !== "visible") {
      setShown(null);
      return;
    }
    const decimals = decimalsIn(text);
    const controls = animate(start, target, {
      duration: COUNT_SECONDS,
      ease: "easeOut",
      onUpdate: (latest) => setShown(latest.toFixed(decimals)),
      onComplete: () => setShown(null),
    });
    const settle = setTimeout(() => setShown(null), COUNT_SECONDS * 1000 + 150);
    return () => {
      controls.stop();
      clearTimeout(settle);
    };
  }, [target, text, reduceMotion]);

  return <>{shown ?? text}</>;
}

export function StatTile({ label, value, sub, dark = false }: { label: string; value: ReactNode; sub?: ReactNode; dark?: boolean }) {
  return (
    <div className={dark ? "tile tile-dark" : "tile"}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub ? <div className="tile-sub">{sub}</div> : null}
    </div>
  );
}

export function DemoBadge() {
  return <span className="badge badge-demo">Demo data</span>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children ? <div className="empty-body">{children}</div> : null}
    </div>
  );
}

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.main id="main" className={className ? `page ${className}` : "page"} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: "easeOut" }}>
      {children}
    </motion.main>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <p className="note note-error" role="alert">{children}</p>;
}
