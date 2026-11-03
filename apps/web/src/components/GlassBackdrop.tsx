// The animated background: see lib/backdrop.ts for what it draws. It's decoration plus one signal, so screen readers skip
// it and it can be paused. It stops when the tab is hidden, holds one still frame for reduced motion or a machine too slow
// to run it smoothly, and without WebGL the page's plain CSS background takes over.
import type { Decision } from "@wardy-agent/core";
import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { FRAGMENT_SHADER, PULSE_COLORS, pulseStrength, VERTEX_SHADER, veilOpacity } from "../lib/backdrop";

const PAUSE_KEY = "wardy-agent-backdrop-paused";
const FRAME_MS = 1000 / 30;
const MAX_DRAWN_WIDTH = 1100;
const SLOW_FRAME_MS = 55;
const FRAMES_TO_JUDGE = 24;
const MIN_QUALITY = 0.4;
const WIDE_SCREEN = 1000;

function readPaused(): boolean {
  try {
    return localStorage.getItem(PAUSE_KEY) === "1";
  } catch {
    return false;
  }
}

/** No graphics card, so the processor would do it all: true on CI and in most virtual machines. */
function isSoftware(gl: WebGLRenderingContext): boolean {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return /swiftshader|llvmpipe|software|microsoft basic/i.test(info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "");
}

function compile(gl: WebGLRenderingContext): WebGLProgram | null {
  const program = gl.createProgram();
  if (!program) return null;
  for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX_SHADER], [gl.FRAGMENT_SHADER, FRAGMENT_SHADER]] as const) {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

export function GlassBackdrop({ signal, dimmed }: { signal: { kind: Decision; at: number } | null; dimmed: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const veilRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const [paused, setPaused] = useState(readPaused);
  const [unavailable, setUnavailable] = useState(false);
  const pausedRef = useRef(paused);
  const refreshRef = useRef<() => void>(() => {});
  const pulseRef = useRef<{ color: [number, number, number]; start: number } | null>(null);

  // A verdict lights the shield in its colour.
  useEffect(() => {
    if (signal) pulseRef.current = { color: PULSE_COLORS[signal.kind], start: performance.now() };
  }, [signal]);

  useEffect(() => {
    const paint = () => {
      if (veilRef.current) veilRef.current.style.opacity = String(veilOpacity(window.scrollY, window.innerHeight, dimmed));
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
    const gl = canvas?.getContext("webgl", { alpha: false, antialias: false, depth: false, powerPreference: "low-power" });
    const program = gl ? compile(gl) : null;
    if (!canvas || !gl || !program) {
      setUnavailable(true);
      return;
    }
    gl.useProgram(program);
    const corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const cornerAt = gl.getAttribLocation(program, "corner");
    gl.enableVertexAttribArray(cornerAt);
    gl.vertexAttribPointer(cornerAt, 2, gl.FLOAT, false, 0, 0);
    const uniforms = {
      size: gl.getUniformLocation(program, "uSize"),
      time: gl.getUniformLocation(program, "uTime"),
      look: gl.getUniformLocation(program, "uLook"),
      pulse: gl.getUniformLocation(program, "uPulse"),
      pulseColor: gl.getUniformLocation(program, "uPulseColor"),
      shift: gl.getUniformLocation(program, "uShift"),
    };

    const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
    const startedAt = performance.now();
    const look = { x: 0, y: 0 };
    const target = { x: 0, y: 0 };
    let quality = 1;
    let frame = 0;
    let running = false;
    let tooSlow = isSoftware(gl);
    let lastDrawn = 0;
    let slowFrames = 0;
    let judged = 0;

    const size = () => {
      const wanted = window.innerWidth * Math.min(window.devicePixelRatio || 1, 2);
      const scale = (Math.min(wanted, MAX_DRAWN_WIDTH) / window.innerWidth) * quality;
      canvas.width = Math.max(1, Math.round(window.innerWidth * scale));
      canvas.height = Math.max(1, Math.round(window.innerHeight * scale));
      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    const draw = (now: number) => {
      const pulse = pulseRef.current;
      const strength = pulse ? pulseStrength(now - pulse.start) : 0;
      if (pulse && strength === 0) pulseRef.current = null;
      look.x += (target.x - look.x) * 0.06;
      look.y += (target.y - look.y) * 0.06;
      gl.uniform2f(uniforms.size, canvas.width, canvas.height);
      gl.uniform1f(uniforms.time, 4 + (now - startedAt) / 1000);
      gl.uniform2f(uniforms.look, look.x, look.y);
      gl.uniform1f(uniforms.pulse, strength);
      // On a wide screen the shield stands to the right of the headline, not behind it.
      gl.uniform1f(uniforms.shift, window.innerWidth >= WIDE_SCREEN ? (window.innerWidth / window.innerHeight) * 0.26 : 0);
      gl.uniform3fv(uniforms.pulseColor, pulse?.color ?? PULSE_COLORS.ALLOW);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const tick = (now: number) => {
      if (!running) return;
      frame = requestAnimationFrame(tick);
      const gap = now - lastDrawn;
      if (gap < FRAME_MS) return;
      lastDrawn = now;
      // A slow machine gets fewer pixels, and if that isn't enough, one still frame. Reading always comes first.
      judged += 1;
      if (gap > SLOW_FRAME_MS) slowFrames += 1;
      if (judged >= FRAMES_TO_JUDGE) {
        const struggling = slowFrames > FRAMES_TO_JUDGE / 2;
        judged = 0;
        slowFrames = 0;
        if (struggling && quality <= MIN_QUALITY) {
          tooSlow = true;
          refresh();
          return;
        }
        if (struggling) {
          quality = Math.max(MIN_QUALITY, quality * 0.7);
          size();
        }
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

    const onResize = () => {
      size();
      if (!running) draw(performance.now());
    };
    const onPointer = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      target.x = (event.clientX / window.innerWidth) * 2 - 1;
      target.y = (event.clientY / window.innerHeight) * 2 - 1;
    };
    const onLost = (event: Event) => {
      event.preventDefault();
      running = false;
      cancelAnimationFrame(frame);
      setUnavailable(true);
    };

    window.addEventListener("resize", onResize);
    window.addEventListener("pointermove", onPointer, { passive: true });
    document.addEventListener("visibilitychange", refresh);
    calm.addEventListener("change", refresh);
    canvas.addEventListener("webglcontextlost", onLost);
    size();
    draw(performance.now());
    refresh();

    return () => {
      running = false;
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointer);
      document.removeEventListener("visibilitychange", refresh);
      calm.removeEventListener("change", refresh);
      canvas.removeEventListener("webglcontextlost", onLost);
      gl.deleteBuffer(corners);
      gl.deleteProgram(program);
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
        {unavailable ? null : <canvas ref={canvasRef} className="backdrop-canvas" data-testid="glass-backdrop" />}
        <div ref={veilRef} className="backdrop-veil" />
      </div>
      {unavailable || reduceMotion ? null : (
        <button type="button" className="backdrop-toggle" onClick={toggle} aria-pressed={paused}>
          {paused ? "Play background" : "Pause background"}
        </button>
      )}
    </>
  );
}
