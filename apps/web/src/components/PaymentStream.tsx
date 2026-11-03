// The checkpoint: what this product does, as a picture. Payments stream in from the left and have to pass through one
// gate, and only what's been checked comes out on the right. The faint dots are decoration. The bright ones are real: each
// verdict sends one payment to the gate, where it goes through, waits, or bounces back in pieces. The flow bends away from
// the pointer, and a click sends a ripple through it. It's drawn on a canvas that screen readers skip, because everything
// it shows is also in the page as text.
import type { Decision } from "@wardy-agent/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { dots, funnel, GATE_AT, pushFrom, tokenAt, TRAVEL_MS, VERDICT_MS } from "../lib/stream";
import { SHIELD_PATH } from "./WardyShield";

const COLORS = { idle: "#c9c9de", checked: "#8b9cff", ALLOW: "#8b9cff", HOLD: "#f5b942", BLOCK: "#ff5a1f" } as const;
const LABELS_HEIGHT = 62;
const PAUSE_HEIGHT = 30;
const MAX_VERDICTS = 4;
const RIPPLE_MS = 900;
const SPARKS = 18;

export interface StreamSignal {
  decision: Decision;
  at: number;
}

export function PaymentStream({ signal, leftLabel, rightLabel }: { signal: StreamSignal | null; leftLabel: React.ReactNode; rightLabel: React.ReactNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const redrawRef = useRef<() => void>(() => {});
  const verdictsRef = useRef<{ decision: Decision; start: number }[]>([]);

  const togglePaused = useCallback(() => {
    setPaused((was) => {
      pausedRef.current = !was;
      return !was;
    });
  }, []);

  useEffect(() => {
    if (!signal) return;
    verdictsRef.current = [...verdictsRef.current, { decision: signal.decision, start: performance.now() }].slice(-MAX_VERDICTS);
    redrawRef.current();
  }, [signal]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const box = boxRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !box || !context) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const shield = new Path2D(SHIELD_PATH);
    let flock = dots(320);
    let width = 0;
    let height = 0;
    let flow = 0;
    let pointer: { x: number; y: number } | null = null;
    let ripples: { x: number; y: number; start: number }[] = [];
    let frame = 0;
    let running = false;
    let onScreen = true;
    let lastTime = 0;

    const size = () => {
      const rect = box.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const count = width < 480 ? 150 : 320;
      if (flock.length !== count) flock = dots(count);
    };

    const draw = (now: number) => {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const usable = height - LABELS_HEIGHT - PAUSE_HEIGHT;
      const centerY = LABELS_HEIGHT + usable / 2;
      const spread = usable * 0.48;
      const gateX = width * GATE_AT;
      const reach = Math.min(width, height) * 0.3;
      verdictsRef.current = verdictsRef.current.filter((verdict) => now - verdict.start < VERDICT_MS);
      ripples = ripples.filter((ripple) => now - ripple.start < RIPPLE_MS);

      for (const dot of flock) {
        const across = (dot.start + flow * dot.speed) % 1;
        let x = across * width;
        let y = centerY + dot.lane * spread * funnel(across) + Math.sin(across * 9 + dot.start * 20) * 3;
        if (pointer) {
          const push = pushFrom(x, y, pointer.x, pointer.y, reach);
          x += push.x;
          y += push.y;
        }
        for (const ripple of ripples) {
          const age = (now - ripple.start) / RIPPLE_MS;
          const ring = Math.abs(Math.hypot(x - ripple.x, y - ripple.y) - age * reach * 2.4);
          if (ring < 34) {
            const push = pushFrom(x, y, ripple.x, ripple.y, Number.MAX_SAFE_INTEGER);
            const size = Math.hypot(push.x, push.y) || 1;
            const strength = (1 - ring / 34) * (1 - age) * 16;
            x += (push.x / size) * strength;
            y += (push.y / size) * strength;
          }
        }
        const checked = across > GATE_AT;
        const edge = Math.min(across, 1 - across) * 12;
        context.globalAlpha = Math.min(1, edge) * (checked ? 0.85 : 0.42);
        context.fillStyle = checked ? COLORS.checked : COLORS.idle;
        context.fillRect(x - dot.size, y - dot.size, dot.size * 2, dot.size * 2);
      }

      // The gate lights up in the colour of the last thing it decided.
      let gateColor: string = COLORS.checked;
      let gateFlash = 0;
      for (const verdict of verdictsRef.current) {
        const elapsed = now - verdict.start;
        if (elapsed >= TRAVEL_MS) {
          gateColor = COLORS[verdict.decision];
          gateFlash = Math.max(gateFlash, 1 - (elapsed - TRAVEL_MS) / (VERDICT_MS - TRAVEL_MS));
        }
      }
      const gateHeight = Math.min(usable * 0.56, 150);
      const scale = gateHeight / 52;
      context.save();
      context.translate(gateX - 24 * scale, centerY - 26 * scale);
      context.scale(scale, scale);
      context.globalAlpha = 1;
      context.fillStyle = "rgba(8, 8, 15, 0.82)";
      context.fill(shield);
      context.strokeStyle = gateColor;
      context.lineWidth = (1.4 + gateFlash * 1.6) / scale + 0.3;
      context.shadowColor = gateColor;
      context.shadowBlur = 12 + gateFlash * 34;
      context.stroke(shield);
      context.restore();

      for (const verdict of verdictsRef.current) {
        const elapsed = now - verdict.start;
        const token = tokenAt(verdict.decision, elapsed);
        if (!token) continue;
        const color = token.decided ? COLORS[verdict.decision] : "#ffffff";
        context.globalAlpha = token.alpha;
        context.fillStyle = color;
        context.shadowColor = color;
        context.shadowBlur = 18;
        context.beginPath();
        context.arc(token.x * width, centerY, 5, 0, Math.PI * 2);
        context.fill();
        context.shadowBlur = 0;
        // A block doesn't just stop the payment: it breaks it, so nobody can miss that it didn't go through.
        if (verdict.decision === "BLOCK" && token.decided) {
          const burst = (elapsed - TRAVEL_MS) / (VERDICT_MS - TRAVEL_MS);
          for (let spark = 0; spark < SPARKS; spark += 1) {
            const angle = Math.PI * 0.55 + (spark / (SPARKS - 1)) * Math.PI * 0.9;
            const distance = burst * (50 + (spark % 5) * 18);
            context.globalAlpha = 1 - burst;
            context.fillRect(gateX + Math.cos(angle) * distance - 2, centerY + Math.sin(angle) * distance - 2, 4, 4);
          }
        }
      }
      context.globalAlpha = 1;
    };

    const shouldRun = () => onScreen && !document.hidden && !reduceMotion.matches;

    const tick = (now: number) => {
      if (!running) return;
      const seconds = Math.min(0.05, (now - lastTime) / 1000 || 0);
      lastTime = now;
      if (!pausedRef.current) flow += seconds;
      draw(now);
      frame = requestAnimationFrame(tick);
    };

    const start = () => {
      if (running || !shouldRun()) return;
      running = true;
      lastTime = performance.now();
      frame = requestAnimationFrame(tick);
    };

    const stop = () => {
      running = false;
      cancelAnimationFrame(frame);
    };

    const refresh = () => {
      if (shouldRun()) start();
      else {
        stop();
        draw(performance.now());
      }
    };

    redrawRef.current = () => {
      if (!running) draw(performance.now());
    };

    const local = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "touch") pointer = local(event);
      if (!running) draw(performance.now());
    };
    const onLeave = () => {
      pointer = null;
      if (!running) draw(performance.now());
    };
    const onDown = (event: PointerEvent) => {
      ripples = [...ripples, { ...local(event), start: performance.now() }].slice(-3);
    };

    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("pointerdown", onDown);

    const onResize = new ResizeObserver(() => {
      size();
      if (!running) draw(performance.now());
    });
    onResize.observe(box);

    // It stops when nobody can see it, so it never drains a laptop or a phone in the background.
    const onView = new IntersectionObserver(([entry]) => {
      onScreen = Boolean(entry?.isIntersecting);
      refresh();
    });
    onView.observe(box);
    document.addEventListener("visibilitychange", refresh);
    reduceMotion.addEventListener("change", refresh);

    size();
    draw(performance.now());
    refresh();

    return () => {
      stop();
      onResize.disconnect();
      onView.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointerdown", onDown);
      document.removeEventListener("visibilitychange", refresh);
      reduceMotion.removeEventListener("change", refresh);
    };
  }, []);

  return (
    <div ref={boxRef} className="stream-box">
      <canvas ref={canvasRef} className="stream-canvas" aria-hidden="true" data-testid="payment-stream" />
      <div className="stream-label stream-label-left">{leftLabel}</div>
      <div className="stream-label stream-label-right">{rightLabel}</div>
      <button type="button" className="stream-pause" onClick={togglePaused} aria-pressed={paused}>
        {paused ? "Resume" : "Pause"}
      </button>
    </div>
  );
}
