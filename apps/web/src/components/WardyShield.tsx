// The mascot: a shield with two slits of light for eyes. Its motion explains something: it glances toward a new verdict, braces on a BLOCK,
// and gives a small nod on an ALLOW. Otherwise it just blinks now and then.
import { motion, useAnimationControls, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

type Reaction = { kind: "BLOCK" | "HOLD" | "ALLOW"; at: number } | null;

export const SHIELD_PATH = "M24 2.5 44 9.4v15.2c0 12.2-8 21.3-20 25.4C12 46 4 36.8 4 24.6V9.4Z";
const BLINK_EVERY_MS = 6000;
const BLINK_FOR_MS = 140;
const LEFT_EYE = 16.5;
const RIGHT_EYE = 31.5;
const EYE_Y = 23;

export function WardyShield({ size = 32, tone = "dark", reaction = null, title, followPointer = false }: { size?: number; tone?: "dark" | "light"; reaction?: Reaction; title?: string; followPointer?: boolean }) {
  const reduceMotion = useReducedMotion();
  const body = useAnimationControls();
  const [blinking, setBlinking] = useState(false);
  const [mood, setMood] = useState<"idle" | "braced" | "looking">("idle");
  const [gaze, setGaze] = useState({ x: 0, y: 0 });
  const self = useRef<SVGSVGElement>(null);

  // Its eyes follow the pointer, a little. A phone has no pointer, so there it just looks ahead.
  useEffect(() => {
    if (reduceMotion || !followPointer) return;
    let frame = 0;
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = self.current?.getBoundingClientRect();
        if (!box) return;
        const dx = event.clientX - (box.left + box.width / 2);
        const dy = event.clientY - (box.top + box.height / 2);
        const distance = Math.hypot(dx, dy) || 1;
        const reach = Math.min(1.5, distance / 90);
        setGaze({ x: (dx / distance) * reach, y: (dy / distance) * reach });
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, [reduceMotion, followPointer]);

  useEffect(() => {
    if (reduceMotion) return;
    let closing: ReturnType<typeof setTimeout>;
    const timer = setInterval(() => {
      setBlinking(true);
      closing = setTimeout(() => setBlinking(false), BLINK_FOR_MS);
    }, BLINK_EVERY_MS);
    return () => {
      clearInterval(timer);
      clearTimeout(closing);
    };
  }, [reduceMotion]);

  useEffect(() => {
    if (!reaction) return;
    if (reduceMotion) return;
    setMood(reaction.kind === "BLOCK" ? "braced" : "looking");
    if (reaction.kind === "BLOCK") void body.start({ scale: [1, 0.86, 1.04, 1], transition: { duration: 0.42, ease: "easeOut" } });
    else if (reaction.kind === "ALLOW") void body.start({ y: [0, 2.2, 0], transition: { duration: 0.32, ease: "easeOut" } });
    const settle = setTimeout(() => setMood("idle"), reaction.kind === "BLOCK" ? 1000 : 800);
    return () => clearTimeout(settle);
  }, [reaction, reduceMotion, body]);

  const shield = tone === "dark" ? "#16181D" : "#00F29B";
  const eye = tone === "dark" ? "#FFFFFF" : "#050809";
  const lid = blinking ? 0.08 : mood === "braced" ? 0.42 : 1;
  // The newest verdict is below and to the left of the header.
  const glance = mood === "idle" ? gaze : { x: -1.3, y: 1.6 };
  const eyeMotion = { type: "tween", duration: blinking ? 0.07 : 0.16, ease: "easeOut" } as const;

  return (
    <motion.svg ref={self} animate={body} className="shield" width={size} height={(size * 52) / 48} viewBox="0 0 48 52" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <path d={SHIELD_PATH} fill={shield} stroke={shield} strokeWidth="2" strokeLinejoin="round" />
      {[LEFT_EYE, RIGHT_EYE].map((cx) => (
        <motion.g key={cx} animate={{ scaleY: lid }} transition={eyeMotion} style={{ transformBox: "fill-box", transformOrigin: "center" }}>
          <motion.rect x={cx - 5.5} y={EYE_Y - 1.9} width="11" height="3.8" rx="1.9" fill={eye} animate={glance} transition={{ type: "tween", duration: 0.18, ease: "easeOut" }} />
        </motion.g>
      ))}
    </motion.svg>
  );
}
