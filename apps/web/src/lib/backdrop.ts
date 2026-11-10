// The timing and colours of the shield behind the dashboard. See components/BlockBackdrop.tsx for the drawing.
import type { Decision } from "@wardy-agent/core";

export const PULSE_MS = 1800;

/** How strongly a verdict still lights the shield, `elapsed` ms after it arrived. */
export function pulseStrength(elapsed: number): number {
  if (elapsed < 0 || elapsed >= PULSE_MS) return 0;
  const left = 1 - elapsed / PULSE_MS;
  return left * left;
}

/** The same colours the verdict chips and the checkpoint's gate mean. */
export const PULSE_COLORS: Record<Decision, [number, number, number]> = {
  ALLOW: [0, 0.95, 0.61],
  HOLD: [0.96, 0.72, 0.26],
  BLOCK: [1, 0.33, 0.1],
};

/** The double-click show: it breaks apart, the blocks swirl round in every verdict's colour, then build it back. */
export const SHOW_MS = 3400;
export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t: number): number => 1 - (1 - t) ** 3;

/** How far the blocks are from their places in the shield, `t` of the way through the show: out fast, round, home gently. */
export function showSpread(t: number): number {
  if (t <= 0 || t >= 1) return 0;
  if (t < 0.18) return easeOut(t / 0.18);
  if (t < 0.66) return 1;
  return 1 - easeInOut((t - 0.66) / 0.34);
}

/** How dark the veil over the shield is. Reading comes first, so it darkens as you scroll, and on every page but the first. */
export function veilOpacity(scrollY: number, viewportHeight: number, dimmed: boolean): number {
  const base = dimmed ? 0.62 : 0;
  const scrolled = viewportHeight > 0 ? Math.min(1, Math.max(0, scrollY) / (viewportHeight * 0.8)) : 0;
  return base + (0.8 - base) * scrolled;
}
