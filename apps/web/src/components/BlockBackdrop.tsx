// The animated background: the Wardy Agent shield, built from the same small blocks as the checkpoint. A run of light
// travels around the outline, and a verdict sweeps through it in its colour. A block breaks it apart for a moment. It
// answers what you do, but says nothing the page doesn't, so screen readers skip it. It can be paused, stops when the tab is
// hidden, holds one still frame for reduced motion or a machine too slow to run it smoothly, and draws half the blocks first.
import type { Decision } from "@wardy-agent/core";
import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { easeInOut, PULSE_COLORS, PULSE_MS, pulseStrength, SHOW_MS, showSpread, veilOpacity } from "../lib/backdrop";
import { blockLevel, eyeBlocks, project, ramp, shieldBlocks } from "../lib/blockShield";
import { pushFrom } from "../lib/stream";

const PAUSE_KEY = "wardy-agent-backdrop-paused";
const WIDE_SCREEN = 1000;
const PHONE_WIDTH = 600;
const SLOW_FRAME_MS = 55;
const THROTTLED_MS = 500;
const FRAMES_TO_JUDGE = 24;
const BLOCK_SIZE = 0.0115;
const RIPPLE_MS = 900;
const BURST_MS = 1100;
const BLINK_EVERY_MS = 5200;
const BLINK_FOR_MS = 130;
const RAMPS = { ALLOW: ramp(PULSE_COLORS.ALLOW), HOLD: ramp(PULSE_COLORS.HOLD), BLOCK: ramp(PULSE_COLORS.BLOCK) };

function readPaused(): boolean {
  try {
    return localStorage.getItem(PAUSE_KEY) === "1";
  } catch {
    return false;
  }
}

export function BlockBackdrop({ signal, dimmed, frozen }: { signal: { kind: Decision; at: number } | null; dimmed: boolean; frozen: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const veilRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const [paused, setPaused] = useState(readPaused);
  const pausedRef = useRef(paused);
  const refreshRef = useRef<() => void>(() => {});
  const pulseRef = useRef<{ kind: Decision; start: number } | null>(null);
  const redrawRef = useRef<() => void>(() => {});
  const exciteRef = useRef(0);
  const showRef = useRef<number | null>(null);
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;

  useEffect(() => {
    if (signal) pulseRef.current = { kind: signal.kind, start: performance.now() };
    redrawRef.current();
  }, [signal]);

  // A new page, or the freeze being pulled: it notices.
  useEffect(() => {
    exciteRef.current = 1;
    redrawRef.current();
  }, [dimmed, frozen]);

  // The light that follows your pointer across a card. It's only a colour change, so it runs for everyone.
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const card = (event.target as Element | null)?.closest?.<HTMLElement>(".card, .tile");
      if (!card) return;
      const box = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${event.clientX - box.left}px`);
      card.style.setProperty("--my", `${event.clientY - box.top}px`);
    };
    document.addEventListener("pointermove", onMove, { passive: true });
    return () => document.removeEventListener("pointermove", onMove);
  }, []);

  useEffect(() => {
    const paint = () => {
      if (veilRef.current) veilRef.current.style.opacity = String(veilOpacity(window.scrollY, window.innerHeight, dimmed || window.innerWidth < WIDE_SCREEN));
    };
    paint();
    window.addEventListener("scroll", paint, { passive: true });
    window.addEventListener("resize", paint);
    return () => {
      window.removeEventListener("scroll", paint);
      window.removeEventListener("resize", paint);
    };
  }, [dimmed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    let blocks = shieldBlocks(window.innerWidth < PHONE_WIDTH ? 0.042 : 0.03);
    let firstBlock = 0;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
    const startedAt = performance.now();
    const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const look = { x: 0, y: 0 };
    let hovering = false;
    let watching: HTMLInputElement | null = null;
    let lastHovered: Element | null = null;
    let lastDrawn = 0;
    let slowFrames = 0;
    let judged = 0;
    let tooSlow = false;
    let ripple: { x: number; y: number; start: number } | null = null;
    let ratio = 1;
    let frame = 0;
    let running = false;

    const size = () => {
      ratio = Math.min(window.devicePixelRatio || 1, 2);
      blocks = shieldBlocks(window.innerWidth < PHONE_WIDTH ? 0.042 : 0.03);
      if (firstBlock > 0) firstBlock = blocks.length / 2;
      canvas.width = Math.round(window.innerWidth * ratio);
      canvas.height = Math.round(window.innerHeight * ratio);
    };

    const draw = (now: number) => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const unit = Math.min(height, width * 1.15);
      const centerX = width / 2 + (width >= WIDE_SCREEN ? (width / height) * 0.26 : 0) * unit;
      const centerY = height / 2;
      const time = 4 + (now - startedAt) / 1000;
      const clamp = (value: number) => Math.max(-1, Math.min(1, value));
      // It watches the field you're typing in, or else your pointer.
      const box = watching?.getBoundingClientRect();
      const lookAtX = box ? box.left + box.width / 2 : pointer.x;
      const lookAtY = box ? box.top + box.height / 2 : pointer.y;
      look.x += (clamp((lookAtX - centerX) / (unit * 0.6)) - look.x) * 0.1;
      look.y += (clamp((centerY - lookAtY) / (unit * 0.5)) - look.y) * 0.1;
      exciteRef.current *= 0.94;
      const excite = exciteRef.current;
      const yaw = Math.sin(time * 0.23) * 0.3 + look.x * 0.3 + window.scrollY * 0.0016;
      const pitch = Math.sin(time * 0.17) * 0.08 - look.y * 0.16;
      const reach = unit * 0.2;

      const pulse = pulseRef.current;
      const elapsed = pulse ? now - pulse.start : 0;
      if (pulse && elapsed >= PULSE_MS) pulseRef.current = null;
      const front = pulse ? (elapsed / PULSE_MS) * 4 : 0;
      const strength = pulse ? pulseStrength(elapsed) : 0;
      const burst = pulse?.kind === "BLOCK" && elapsed < BURST_MS ? Math.sin((elapsed / BURST_MS) * Math.PI) ** 2 : 0;
      const isFrozen = frozenRef.current;
      const rippleAge = ripple ? (now - ripple.start) / RIPPLE_MS : 1;
      if (rippleAge >= 1) ripple = null;
      const showAt = showRef.current === null ? 1 : (now - showRef.current) / SHOW_MS;
      if (showRef.current !== null && showAt >= 1) {
        // Built back: a green sweep says it's whole again.
        showRef.current = null;
        pulseRef.current = { kind: "ALLOW", start: now };
        exciteRef.current = 1;
      }
      const spread = showSpread(showAt);
      const spin = easeInOut(Math.min(1, Math.max(0, showAt))) * Math.PI * 2;
      const showRamps = [RAMPS.ALLOW, RAMPS.HOLD, RAMPS.BLOCK];

      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      // No light behind it at rest: the blocks stand on the dark. A verdict or a freeze still flashes its colour there.
      const glowColor = isFrozen ? "255,84,26" : pulse && strength > 0.05 ? PULSE_COLORS[pulse.kind].map((c) => Math.round(c * 255)).join(",") : "0,242,155";
      const haloAlpha = isFrozen ? 0.1 : strength * 0.14 + excite * 0.1;
      if (haloAlpha > 0.005) {
        const halo = context.createRadialGradient(centerX, centerY, unit * 0.05, centerX, centerY, unit * 0.62);
        halo.addColorStop(0, `rgba(${glowColor},${haloAlpha})`);
        halo.addColorStop(1, `rgba(${glowColor},0)`);
        context.fillStyle = halo;
        context.fillRect(0, 0, width, height);
      }

      const normal = isFrozen ? RAMPS.BLOCK : RAMPS.ALLOW;
      const swept = pulse ? RAMPS[pulse.kind] : normal;
      const top = normal.length - 1;
      for (let index = firstBlock; index < blocks.length; index += 1) {
        const block = blocks[index] as (typeof blocks)[number];
        let bx = block.x;
        let by = block.y;
        let bz = block.z;
        if (burst > 0) {
          const angle = block.seed * Math.PI * 2;
          const distance = burst * (0.08 + block.seed * 0.24);
          bx += Math.cos(angle) * distance;
          by += Math.sin(angle) * distance;
          bz += (block.seed - 0.5) * burst * 0.5;
        }
        if (spread > 0) {
          // Each block has its own orbit, and the ones further out go round a little faster, like a whirlpool.
          const turn = block.seed * 7.3 + index * 0.61;
          const radius = 0.32 + ((index * 0.37) % 1) * 0.62;
          const angle = turn + spin * (1.1 + radius * 0.9);
          bx += (Math.cos(angle) * radius * 1.25 - bx) * spread;
          by += (Math.sin(angle) * radius * 0.85 - by) * spread;
          bz += ((block.seed - 0.5) * 0.8 - bz) * spread;
        }
        const seen = project(bx, by, bz, yaw, pitch);
        let x = centerX + seen.x * unit;
        let y = centerY - seen.y * unit;
        const push = hovering ? pushFrom(x, y, pointer.x, pointer.y, reach) : null;
        if (push) {
          x += push.x;
          y += push.y;
        }
        if (ripple) {
          const dx = x - ripple.x;
          const dy = y - ripple.y;
          const away = Math.hypot(dx, dy) || 1;
          const ring = Math.abs(away - rippleAge * unit * 0.7);
          if (ring < 40) {
            const shove = (1 - ring / 40) * (1 - rippleAge) * 18;
            x += (dx / away) * shove;
            y += (dy / away) * shove;
          }
        }

        const isFront = block.z > 0;
        const level = Math.min(1, blockLevel(block, time) + (isFront ? excite * 0.22 : 0) + (push && (push.x || push.y) ? 0.25 : 0));
        const inWave = Boolean(pulse) && strength > 0.02 && Math.hypot(block.x, block.y) < front;
        context.globalAlpha = isFront ? 1 : 0.45;
        const showColours = spread > 0.5 ? showRamps[Math.floor((block.seed + showAt * 1.6) * 3) % 3] : undefined;
        context.fillStyle = (showColours ?? (inWave ? swept : normal))[Math.round(Math.max(level, spread * 0.8) * top)] as string;
        const side = BLOCK_SIZE * unit * seen.near * (isFront ? 1.5 : 1.1);
        context.fillRect(x - side / 2, y - side / 2, side, side);
      }

      // The eyes: the brightest blocks on the shield. They slide toward the pointer, and close to blink.
      const blinking = (now - startedAt) % BLINK_EVERY_MS < BLINK_FOR_MS;
      const glaring = isFrozen || burst > 0;
      const rows = watching?.type === "password" || blinking ? 1 : glaring ? 2 : 3;
      // The eyes fade while the shield is in pieces, and open again once it's whole.
      context.globalAlpha = 1 - spread;
      context.fillStyle = isFrozen ? "#ff8a5c" : pulse && strength > 0.02 ? (swept[top] as string) : "#5dffbe";
      context.shadowColor = `rgb(${glowColor})`;
      context.shadowBlur = 10;
      for (const eye of eyeBlocks(rows, look.x, look.y)) {
        const seen = project(eye.x, eye.y, 0.04, yaw, pitch);
        const side = BLOCK_SIZE * unit * seen.near * 2;
        context.fillRect(centerX + seen.x * unit - side / 2, centerY - seen.y * unit - side / 2, side, side);
      }
      context.shadowBlur = 0;
      context.globalAlpha = 1;
    };

    const tick = (now: number) => {
      if (!running) return;
      frame = requestAnimationFrame(tick);
      // A slow machine gets half the blocks, and if that isn't enough, one still frame. Reading always comes first.
      judged += 1;
      // A gap this long means the browser is holding the page back while it's out of view, not that it's struggling.
      const gap = now - lastDrawn;
      if (gap > SLOW_FRAME_MS && gap < THROTTLED_MS) slowFrames += 1;
      lastDrawn = now;
      if (judged >= FRAMES_TO_JUDGE) {
        const struggling = slowFrames > FRAMES_TO_JUDGE / 2;
        judged = 0;
        slowFrames = 0;
        if (struggling && firstBlock > 0) {
          tooSlow = true;
          refresh();
          return;
        }
        // The back layer goes first: the front alone still reads as the shield.
        if (struggling) firstBlock = blocks.length / 2;
      }
      draw(now);
    };

    const refresh = () => {
      const go = !document.hidden && !calm.matches && !pausedRef.current && !tooSlow;
      if (go && !running) {
        running = true;
        lastDrawn = performance.now();
        judged = 0;
        slowFrames = 0;
        frame = requestAnimationFrame(tick);
      } else if (!go) {
        running = false;
        cancelAnimationFrame(frame);
      }
    };
    refreshRef.current = refresh;
    redrawRef.current = () => {
      if (!running) draw(performance.now());
    };

    const onResize = () => {
      size();
      if (!running) draw(performance.now());
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      hovering = true;
    };
    const onLeave = () => {
      hovering = false;
    };
    const onDown = (event: PointerEvent) => {
      ripple = { x: event.clientX, y: event.clientY, start: performance.now() };
      exciteRef.current = 1;
    };
    // Everything you touch gets a reaction: a hover lifts its glow, a press sends a ring from that spot, typing wakes it.
    const onOver = (event: PointerEvent) => {
      const thing = (event.target as Element | null)?.closest?.("a, button, input, summary, .feed-row, .tile");
      if (thing && thing !== lastHovered) exciteRef.current = Math.max(exciteRef.current, thing.matches(".tile") ? 0.3 : 0.6);
      lastHovered = thing ?? null;
    };
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof HTMLInputElement) watching = event.target;
    };
    const onBlur = () => {
      watching = null;
    };
    const onType = () => {
      exciteRef.current = Math.max(exciteRef.current, 0.5);
    };
    // A double click on the shield itself, not on anything on top of it, puts on a short show. Just for fun.
    const onDouble = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.("a, button, input, textarea, select, summary, label, .card, .tile, .stream-panel, .feed-row, .hold-alert, .header, table, code, pre")) return;
      if (!running || showRef.current !== null) return;
      window.getSelection()?.removeAllRanges();
      showRef.current = performance.now();
      pulseRef.current = { kind: "BLOCK", start: performance.now() };
      exciteRef.current = 1;
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    document.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("pointerover", onOver, { passive: true });
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    document.addEventListener("input", onType);
    document.addEventListener("dblclick", onDouble);
    document.addEventListener("visibilitychange", refresh);
    calm.addEventListener("change", refresh);
    size();
    draw(performance.now());
    refresh();

    return () => {
      running = false;
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
      document.removeEventListener("input", onType);
      document.removeEventListener("dblclick", onDouble);
      document.removeEventListener("visibilitychange", refresh);
      calm.removeEventListener("change", refresh);
    };
  }, []);

  const toggle = () => {
    const next = !paused;
    pausedRef.current = next;
    setPaused(next);
    refreshRef.current();
    try {
      localStorage.setItem(PAUSE_KEY, next ? "1" : "0");
    } catch {
      // Private window: it just won't be remembered.
    }
  };

  return (
    <>
      <div className="backdrop" aria-hidden="true">
        <canvas ref={canvasRef} className="backdrop-canvas" data-testid="shield-backdrop" />
        <div ref={veilRef} className="backdrop-veil" />
      </div>
      {reduceMotion ? null : (
        <button type="button" className="backdrop-toggle" onClick={toggle} aria-pressed={paused}>
          {paused ? "Play background" : "Pause background"}
        </button>
      )}
    </>
  );
}
