// The geometry behind the checkpoint: many agents' payments on the left, one gate in the middle, and only what's been
// checked coming out on the right. Kept apart from the drawing so it can be tested.
import type { Decision } from "@wardy-agent/core";

export const GATE_AT = 0.5;
export const TRAVEL_MS = 900;
export const SETTLE_MS = 1500;
export const VERDICT_MS = TRAVEL_MS + SETTLE_MS;

/** How far from the centre line a lane sits at `x` (0 to 1 across): wide at the edges, narrow through the gate. */
export function funnel(x: number): number {
  return 0.1 + 0.9 * Math.min(1, Math.abs(x - GATE_AT) * 2) ** 1.4;
}

/** The same payment seen `elapsed` ms after its verdict: it travels to the gate, and then the verdict decides what it does. */
export function tokenAt(decision: Decision, elapsed: number): { x: number; alpha: number; decided: boolean } | null {
  if (elapsed < 0 || elapsed >= VERDICT_MS) return null;
  if (elapsed < TRAVEL_MS) {
    const going = elapsed / TRAVEL_MS;
    return { x: GATE_AT * going * (2 - going), alpha: 1, decided: false };
  }
  const after = (elapsed - TRAVEL_MS) / SETTLE_MS;
  if (decision === "ALLOW") return { x: GATE_AT + (1 - GATE_AT) * after * after, alpha: 1, decided: true };
  if (decision === "HOLD") return { x: GATE_AT, alpha: 1 - after * after, decided: true };
  return { x: GATE_AT - 0.14 * after * (2 - after), alpha: 1 - after, decided: true };
}

/** How far the pointer pushes a dot at (`x`, `y`): strongest under the pointer, nothing past `radius`. */
export function pushFrom(x: number, y: number, pointerX: number, pointerY: number, radius: number): { x: number; y: number } {
  const dx = x - pointerX;
  const dy = y - pointerY;
  const distance = Math.hypot(dx, dy);
  if (distance >= radius || radius <= 0) return { x: 0, y: 0 };
  const near = 1 - distance / radius;
  const push = near * near * radius * 0.55;
  if (distance === 0) return { x: 0, y: -push };
  return { x: (dx / distance) * push, y: (dy / distance) * push };
}

/** Fixed starting places, so the picture looks the same on every load. */
export function dots(count: number): { lane: number; start: number; speed: number; size: number }[] {
  // A fixed scatter. Anything more regular than this lines the dots up into stripes.
  const scatter = (index: number, salt: number) => {
    const value = Math.sin((index + 1) * 12.9898 + salt * 78.233) * 43758.5453;
    return value - Math.floor(value);
  };
  return Array.from({ length: count }, (_unused, index) => ({
    lane: scatter(index, 1) * 2 - 1,
    start: scatter(index, 2),
    speed: 0.045 + scatter(index, 3) * 0.05,
    size: 1 + scatter(index, 4) * 1.1,
  }));
}
