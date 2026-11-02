// Runs a number's count-up. The exact value always wins in the end, whatever happens to the animation: a background tab
// can stall animation frames for as long as it likes, and a security console must not sit on a wrong number meanwhile.
export interface CountUpOptions {
  from: number;
  to: number;
  decimals: number;
  seconds: number;
  /** Shows a number mid-count, or null to show the exact value. */
  show(text: string | null): void;
  animate(from: number, to: number, options: { duration: number; ease: "easeOut"; onUpdate(latest: number): void; onComplete(): void }): { stop(): void };
}

const SETTLE_GRACE_MS = 150;

export function startCountUp({ from, to, decimals, seconds, show, animate }: CountUpOptions): () => void {
  const controls = animate(from, to, {
    duration: seconds,
    ease: "easeOut",
    onUpdate: (latest) => show(latest.toFixed(decimals)),
    onComplete: () => show(null),
  });
  const settle = setTimeout(() => show(null), seconds * 1000 + SETTLE_GRACE_MS);
  return () => {
    controls.stop();
    clearTimeout(settle);
  };
}
