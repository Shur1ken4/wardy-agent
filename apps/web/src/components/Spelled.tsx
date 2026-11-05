// A name spelled out one letter at a time, the way Wardy Agent reads it, with the character that gives a lookalike away
// marked at the end. The full name is in the page for screen readers, and the feed says the same thing.
import { useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import type { PayeePart } from "../lib/format";

const LETTER_MS = 38;
const MAX_SHOWN = 32;

export function Spelled({ parts, spellKey }: { parts: PayeePart[]; spellKey: string }) {
  const reduceMotion = useReducedMotion();
  const letters = parts.flatMap((part) => [...part.text].map((character) => ({ character, differs: part.differs }))).slice(0, MAX_SHOWN);
  const [shown, setShown] = useState(reduceMotion ? letters.length : 0);

  useEffect(() => {
    if (reduceMotion) {
      setShown(letters.length);
      return;
    }
    setShown(0);
    // By the clock, not by counting ticks: a busy machine skips ticks, and the name must finish before the next payment.
    const startedAt = performance.now();
    const timer = setInterval(() => {
      const count = Math.min(letters.length, Math.floor((performance.now() - startedAt) / LETTER_MS));
      setShown(count);
      if (count >= letters.length) clearInterval(timer);
    }, LETTER_MS);
    return () => clearInterval(timer);
    // spellKey is what says it's a new name to read.
  }, [spellKey, letters.length, reduceMotion]);

  return (
    <span className="spelled" aria-hidden="true">
      {letters.map(({ character, differs }, index) => (
        <span key={`${spellKey}-${index}`} className={`${differs && shown >= letters.length ? "spelled-odd" : ""} ${index < shown ? "" : "spelled-waiting"}`.trim() || undefined}>
          {character}
        </span>
      ))}
    </span>
  );
}
