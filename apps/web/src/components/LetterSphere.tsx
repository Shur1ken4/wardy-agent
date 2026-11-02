// A sphere of the characters account names are made of, because reading those names is what this product does. It turns
// slowly, you can drag it, and letters near the pointer lift toward you. Each payment sends a wave across it in the
// verdict's colour, and the thin lines point at real data. It's drawn on a canvas that screen readers skip: everything it
// shows is also in the page as text.
import type { Decision } from "@wardy-agent/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { ACCOUNT_CHARACTERS, characterFor, lensStrength, project, type Point3, rotate, spherePoints, waveStrength } from "../lib/sphere";

const COLORS = { ink: "#16181d", ALLOW: "#1a3fb0", HOLD: "#b07a12", BLOCK: "#c2410c", lens: "#1a3fb0" } as const;
type Tone = keyof typeof COLORS;
const TONES = Object.keys(COLORS) as Tone[];

const IDLE_TURN_PER_SECOND = 0.16;
const WAVE_MS = 1500;
const MAX_WAVES = 3;
const ATLAS_SIZE = 28;
const ATLAS_FONT_SIZE = 20;
const LABELS_HEIGHT = 62;
const PAUSE_HEIGHT = 30;

export interface SphereSignal {
  decision: Decision;
  at: number;
}

interface Wave {
  origin: Point3;
  tone: Tone;
  start: number;
}

/** Each character in each colour, drawn once ahead of time, so hundreds of letters stay smooth at 60 fps. */
function buildAtlas(ratio: number): Map<string, HTMLCanvasElement> {
  const atlas = new Map<string, HTMLCanvasElement>();
  for (const tone of TONES) {
    for (const character of ACCOUNT_CHARACTERS) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = Math.ceil(ATLAS_SIZE * ratio);
      const context = canvas.getContext("2d");
      if (!context) continue;
      context.scale(ratio, ratio);
      context.font = `500 ${ATLAS_FONT_SIZE}px "JetBrains Mono Variable", ui-monospace, monospace`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = COLORS[tone];
      context.fillText(character, ATLAS_SIZE / 2, ATLAS_SIZE / 2);
      atlas.set(`${tone}:${character}`, canvas);
    }
  }
  return atlas;
}

export function LetterSphere({ signal, leftLabel, rightLabel }: { signal: SphereSignal | null; leftLabel: React.ReactNode; rightLabel: React.ReactNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const redrawRef = useRef<() => void>(() => {});
  const wavesRef = useRef<Wave[]>([]);

  const togglePaused = useCallback(() => {
    setPaused((was) => {
      pausedRef.current = !was;
      return !was;
    });
  }, []);

  // A verdict arrives: a wave starts from a point facing the viewer.
  useEffect(() => {
    if (!signal) return;
    const angle = (signal.at % 628) / 100;
    const origin = { x: Math.cos(angle) * 0.5, y: Math.sin(angle) * 0.5, z: Math.sqrt(0.5) };
    wavesRef.current = [...wavesRef.current, { origin, tone: signal.decision, start: performance.now() }].slice(-MAX_WAVES);
    redrawRef.current();
  }, [signal]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const box = boxRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !box || !context) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    let atlas: Map<string, HTMLCanvasElement> | null = null;
    let points: Point3[] = [];
    let characters: string[] = [];
    let width = 0;
    let height = 0;
    let yaw = 0.6;
    let pitch = -0.28;
    let spinVelocity = 0;
    let dragging = false;
    let lastPointer = { x: 0, y: 0 };
    let pointer: { x: number; y: number } | null = null;
    let frame = 0;
    let running = false;
    let onScreen = true;
    let lastTime = 0;
    const tracked: Point3[] = [];

    const size = () => {
      const rect = box.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      // Fewer letters on a small screen: they'd only blur together, and a phone has less to spare.
      const count = width < 480 ? 620 : 1250;
      if (points.length !== count) {
        points = spherePoints(count);
        characters = points.map((_point, index) => characterFor(index));
      }
    };

    const draw = (now: number) => {
      if (!atlas) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      // Below the labels and above the pause button, so nothing overlaps at any size. Nearer letters look bigger, so the
      // ball is drawn a little smaller than the space it has.
      const usable = height - LABELS_HEIGHT - PAUSE_HEIGHT;
      const radius = (Math.min(width, usable) / 2) * 0.76;
      const centerX = width / 2;
      const centerY = LABELS_HEIGHT + usable / 2;
      const letter = Math.max(7.5, radius * 0.046);
      const lens = radius * 0.42;
      wavesRef.current = wavesRef.current.filter((wave) => now - wave.start < WAVE_MS);

      // The far side first, faintly, then the near side over it.
      for (const side of [-1, 1]) {
        for (let index = 0; index < points.length; index += 1) {
          const turned = rotate(points[index] as Point3, yaw, pitch);
          if (side < 0 ? turned.z >= 0 : turned.z < 0) continue;
          const spot = project(turned, radius, centerX, centerY);
          let tone: Tone = "ink";
          let lift = 0;
          let glow = 0;
          for (const wave of wavesRef.current) {
            const strength = waveStrength(points[index] as Point3, wave.origin, (now - wave.start) / WAVE_MS);
            if (strength > glow) {
              glow = strength;
              tone = wave.tone;
            }
          }
          if (pointer && side > 0) {
            lift = lensStrength(spot.x, spot.y, pointer.x, pointer.y, lens);
            if (lift > 0.08 && glow < lift) tone = "lens";
          }
          const depth = (turned.z + 1) / 2;
          const alpha = side < 0 ? 0.04 + depth * 0.12 : 0.3 + depth * 0.55;
          context.globalAlpha = Math.min(1, alpha + Math.max(glow, lift) * 0.7);
          const drawn = letter * spot.scale * (1 + lift * 0.75 + glow * 0.45);
          const image = atlas.get(`${tone}:${characters[index]}`);
          if (image) context.drawImage(image, spot.x - drawn * 0.7, spot.y - drawn * 0.7, drawn * 1.4, drawn * 1.4);
        }
      }
      context.globalAlpha = 1;

      // The lines to the two corners, from whichever letters face those corners now.
      const anchors = [{ corner: { x: 26, y: 58 }, want: { x: -0.42, y: -0.3 } }, { corner: { x: width - 26, y: 58 }, want: { x: 0.42, y: -0.3 } }];
      context.lineWidth = 1;
      anchors.forEach(({ corner, want }, which) => {
        let best = -1;
        let bestScore = Number.POSITIVE_INFINITY;
        for (let index = 0; index < points.length; index += 3) {
          const turned = rotate(points[index] as Point3, yaw, pitch);
          if (turned.z < 0.45) continue;
          const score = (turned.x - want.x) ** 2 + (turned.y - want.y) ** 2;
          if (score < bestScore) {
            bestScore = score;
            best = index;
          }
        }
        if (best < 0) return;
        const point = points[best] as Point3;
        tracked[which] = point;
        const spot = project(rotate(point, yaw, pitch), radius, centerX, centerY);
        context.strokeStyle = COLORS.ink;
        context.globalAlpha = 0.34;
        context.beginPath();
        context.moveTo(corner.x, corner.y);
        context.lineTo(spot.x, spot.y);
        context.stroke();
        context.globalAlpha = 1;
        context.fillStyle = COLORS.ink;
        context.fillRect(spot.x - 1.5, spot.y - 1.5, 3, 3);
      });
    };

    const shouldRun = () => onScreen && !document.hidden && !reduceMotion.matches;

    const tick = (now: number) => {
      if (!running) return;
      const seconds = Math.min(0.05, (now - lastTime) / 1000 || 0);
      lastTime = now;
      if (!dragging && !pausedRef.current) yaw += IDLE_TURN_PER_SECOND * seconds;
      if (!dragging) {
        yaw += spinVelocity * seconds;
        spinVelocity *= 0.94;
      }
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
      const at = local(event);
      if (dragging) {
        const dx = at.x - lastPointer.x;
        const dy = at.y - lastPointer.y;
        yaw += dx * 0.008;
        pitch = Math.max(-1.1, Math.min(1.1, pitch + dy * 0.006));
        spinVelocity = dx * 0.28;
        lastPointer = at;
      }
      if (event.pointerType !== "touch") pointer = at;
      if (!running) draw(performance.now());
    };
    const onLeave = () => {
      pointer = null;
      if (!running) draw(performance.now());
    };
    const onDown = (event: PointerEvent) => {
      dragging = true;
      lastPointer = local(event);
      canvas.setPointerCapture(event.pointerId);
      box.classList.add("is-dragging");
    };
    const onUp = () => {
      dragging = false;
      box.classList.remove("is-dragging");
    };

    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);

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

    let cancelled = false;
    size();
    // The letters need the real font, or the atlas would hold the fallback's shapes.
    void document.fonts.load(`500 ${ATLAS_FONT_SIZE}px "JetBrains Mono Variable"`, "a").finally(() => {
      if (cancelled) return;
      atlas = buildAtlas(ratio);
      draw(performance.now());
      refresh();
    });

    return () => {
      cancelled = true;
      stop();
      onResize.disconnect();
      onView.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      document.removeEventListener("visibilitychange", refresh);
      reduceMotion.removeEventListener("change", refresh);
    };
  }, []);

  return (
    <div ref={boxRef} className="sphere-box">
      <canvas ref={canvasRef} className="sphere-canvas" aria-hidden="true" data-testid="letter-sphere" />
      <span className="bracket bracket-left" aria-hidden="true" />
      <span className="bracket bracket-right" aria-hidden="true" />
      <div className="sphere-label sphere-label-left">{leftLabel}</div>
      <div className="sphere-label sphere-label-right">{rightLabel}</div>
      <button type="button" className="sphere-pause" onClick={togglePaused} aria-pressed={paused}>
        {paused ? "Resume turning" : "Pause"}
      </button>
    </div>
  );
}
