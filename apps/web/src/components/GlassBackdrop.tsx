// The animated background: see lib/backdrop.ts for what it draws. It answers what you do, and every verdict, but it says
// nothing the page doesn't, so screen readers skip it. It can be paused. It stops when the tab is hidden, holds one still frame for reduced motion or a machine too slow
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
const RIPPLE_MS = 900;
const BLINK_EVERY_MS = 5200;
const BLINK_FOR_MS = 130;
const GLARE_MS = 1000;

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

export function GlassBackdrop({ signal, dimmed, frozen }: { signal: { kind: Decision; at: number } | null; dimmed: boolean; frozen: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const veilRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const [paused, setPaused] = useState(readPaused);
  const [unavailable, setUnavailable] = useState(false);
  const pausedRef = useRef(paused);
  const refreshRef = useRef<() => void>(() => {});
  const pulseRef = useRef<{ color: [number, number, number]; start: number } | null>(null);
  const exciteRef = useRef(0);
  const glareUntilRef = useRef(0);
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;

  // A verdict lights the shield in its colour.
  useEffect(() => {
    if (!signal) return;
    pulseRef.current = { color: PULSE_COLORS[signal.kind], start: performance.now() };
    if (signal.kind === "BLOCK") glareUntilRef.current = performance.now() + GLARE_MS;
  }, [signal]);

  // A new page, or the freeze being pulled: it notices.
  useEffect(() => {
    exciteRef.current = 1;
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
      gaze: gl.getUniformLocation(program, "uGaze"),
      lid: gl.getUniformLocation(program, "uLid"),
      excite: gl.getUniformLocation(program, "uExcite"),
      spin: gl.getUniformLocation(program, "uSpin"),
      ripple: gl.getUniformLocation(program, "uRipple"),
    };

    const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
    const startedAt = performance.now();
    const look = { x: 0, y: 0 };
    const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    let spin = 0;
    let lid = 0;
    let watching: HTMLInputElement | null = null;
    let lastHovered: Element | null = null;
    let ripple: { x: number; y: number; start: number } | null = null;
    const shiftNow = () => (window.innerWidth >= WIDE_SCREEN ? (window.innerWidth / window.innerHeight) * 0.26 : 0);
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
      let strength = pulse ? pulseStrength(now - pulse.start) : 0;
      if (pulse && strength === 0) pulseRef.current = null;
      // Frozen: it stays orange, so nobody has to read the banner to know.
      const frozenNow = frozenRef.current;
      if (frozenNow) strength = Math.max(strength, 0.62);

      // It watches the field you're typing in, or else your pointer, measured from where the shield really is.
      const unit = Math.min(window.innerHeight, window.innerWidth * 1.15);
      const shieldX = window.innerWidth / 2 + shiftNow() * unit;
      const box = watching?.getBoundingClientRect();
      const lookAtX = box ? box.left + box.width / 2 : pointer.x;
      const lookAtY = box ? box.top + box.height / 2 : pointer.y;
      const clamp = (value: number) => Math.max(-1, Math.min(1, value));
      look.x += (clamp((lookAtX - shieldX) / (unit * 0.6)) - look.x) * 0.12;
      look.y += (clamp((window.innerHeight / 2 - lookAtY) / (unit * 0.5)) - look.y) * 0.12;

      // It closes its eyes while you type a credential, narrows them at a block, and blinks now and then.
      const blinking = (now - startedAt) % BLINK_EVERY_MS < BLINK_FOR_MS;
      const wantedLid = watching?.type === "password" ? 1 : blinking ? 1 : now < glareUntilRef.current || frozenNow ? 0.5 : 0;
      lid += (wantedLid - lid) * 0.35;
      spin += (window.scrollY * 0.0016 - spin) * 0.1;
      exciteRef.current *= 0.92;

      const rippleLeft = ripple ? 1 - (now - ripple.start) / RIPPLE_MS : 0;
      if (rippleLeft <= 0) ripple = null;
      const toPixels = canvas.width / window.innerWidth;
      gl.uniform2f(uniforms.gaze, look.x, look.y);
      gl.uniform1f(uniforms.lid, lid);
      gl.uniform1f(uniforms.excite, exciteRef.current);
      gl.uniform1f(uniforms.spin, spin);
      gl.uniform3f(uniforms.ripple, (ripple?.x ?? 0) * toPixels, canvas.height - (ripple?.y ?? 0) * toPixels, Math.max(0, rippleLeft));
      gl.uniform2f(uniforms.size, canvas.width, canvas.height);
      gl.uniform1f(uniforms.time, 4 + (now - startedAt) / 1000);
      gl.uniform2f(uniforms.look, look.x, look.y);
      gl.uniform1f(uniforms.pulse, strength);
      // On a wide screen the shield stands to the right of the headline, not behind it.
      gl.uniform1f(uniforms.shift, shiftNow());
      gl.uniform3fv(uniforms.pulseColor, frozenNow ? PULSE_COLORS.BLOCK : (pulse?.color ?? PULSE_COLORS.ALLOW));
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
      pointer.x = event.clientX;
      pointer.y = event.clientY;
    };
    // Everything you touch gets a reaction: a hover lifts its glow, a press sends a ring from that spot, typing wakes it.
    const onOver = (event: PointerEvent) => {
      const thing = (event.target as Element | null)?.closest?.("a, button, input, summary, .feed-row, .tile");
      if (thing && thing !== lastHovered) exciteRef.current = Math.max(exciteRef.current, thing.matches(".tile") ? 0.3 : 0.6);
      lastHovered = thing ?? null;
    };
    const onPress = (event: PointerEvent) => {
      ripple = { x: event.clientX, y: event.clientY, start: performance.now() };
      exciteRef.current = 1;
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
    const onLost = (event: Event) => {
      event.preventDefault();
      running = false;
      cancelAnimationFrame(frame);
      setUnavailable(true);
    };

    window.addEventListener("resize", onResize);
    window.addEventListener("pointermove", onPointer, { passive: true });
    document.addEventListener("pointerover", onOver, { passive: true });
    document.addEventListener("pointerdown", onPress, { passive: true });
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    document.addEventListener("input", onType);
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
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerdown", onPress);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
      document.removeEventListener("input", onType);
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
