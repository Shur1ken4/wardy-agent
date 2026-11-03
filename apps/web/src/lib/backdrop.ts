// The glass shield behind the dashboard, drawn live by the graphics card instead of played from a video file: there's
// nothing to download, it works offline, and it can react to a verdict, which a video can't. The shape is the Wardy Agent
// shield, with its two eyes. It's a small raymarcher: the shield's outline is a formula, and each pixel walks along its
// ray until it reaches the surface.
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

/** How dark the veil over the shield is. Reading comes first, so it darkens as you scroll, and on every page but the first. */
export function veilOpacity(scrollY: number, viewportHeight: number, dimmed: boolean): number {
  const base = dimmed ? 0.62 : 0;
  const scrolled = viewportHeight > 0 ? Math.min(1, Math.max(0, scrollY) / (viewportHeight * 0.8)) : 0;
  return base + (0.8 - base) * scrolled;
}

export const VERTEX_SHADER = `
attribute vec2 corner;
void main() { gl_Position = vec4(corner, 0.0, 1.0); }
`;

export const FRAGMENT_SHADER = `
precision highp float;
uniform vec2 uSize;
uniform float uTime;
uniform vec2 uLook;
uniform float uPulse;
uniform vec3 uPulseColor;
uniform float uShift;

const vec2 EYE = vec2(0.29, 0.14);
const float EYE_RADIUS = 0.15;

// The shield's outline, as a distance: straight sides, a sloped top, and two arcs meeting at the bottom point.
float shieldOutline(vec2 p) {
  float a = abs(p.x);
  float side = p.y < 0.05 ? length(vec2(a + 0.3965, p.y - 0.05)) - 1.2165 : a - 0.82;
  float top = dot(vec2(a, p.y - 1.0), vec2(0.33, 0.944));
  float h = max(0.08 - abs(side - top), 0.0) / 0.08;
  return max(side, top) + h * h * 0.02;
}

float ribbon(vec3 p) {
  float flat2d = abs(shieldOutline(p.xy) + 0.15) - 0.02;
  vec2 w = vec2(flat2d, abs(p.z) - 0.02);
  return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - 0.11;
}

float eyes(vec3 p) {
  return length(vec3(abs(p.x) - EYE.x, p.y - EYE.y, p.z)) - EYE_RADIUS;
}

float scene(vec3 p) { return min(ribbon(p), eyes(p)); }

vec3 normalAt(vec3 p) {
  const vec2 e = vec2(0.0015, -0.0015);
  return normalize(e.xyy * scene(p + e.xyy) + e.yyx * scene(p + e.yyx) + e.yxy * scene(p + e.yxy) + e.xxx * scene(p + e.xxx));
}

mat3 turn(float yaw, float pitch) {
  float cy = cos(yaw), sy = sin(yaw), cp = cos(pitch), sp = sin(pitch);
  return mat3(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy) * mat3(1.0, 0.0, 0.0, 0.0, cp, sp, 0.0, -sp, cp);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uSize) / min(uSize.y, uSize.x * 1.15) - vec2(uShift, 0.0);
  float radius = length(uv);

  mat3 toShield = turn(sin(uTime * 0.23) * 0.42 + uLook.x * 0.22, sin(uTime * 0.17) * 0.1 - uLook.y * 0.12);
  vec3 origin = toShield * vec3(0.0, 0.0, 4.2);
  vec3 ray = toShield * normalize(vec3(uv, -1.6));

  // Deep green-black, fading out to the page's own colour at the edges.
  vec3 color = mix(vec3(0.012, 0.05, 0.042), vec3(0.02, 0.031, 0.035), smoothstep(0.1, 0.85, radius));
  vec3 glowColor = mix(vec3(0.0, 0.95, 0.61), uPulseColor, uPulse);

  float t = 2.4;
  float nearest = 10.0;
  bool hit = false;
  for (int i = 0; i < 44; i++) {
    float d = scene(origin + ray * t);
    nearest = min(nearest, d);
    if (d < 0.002) { hit = true; break; }
    t += d * 0.92;
    if (t > 6.2) break;
  }

  color += glowColor * exp(-nearest * 5.5) * (0.34 + uPulse * 0.5);

  if (hit) {
    vec3 p = origin + ray * t;
    vec3 n = normalAt(p);
    float facing = max(dot(n, -ray), 0.0);
    float rim = pow(1.0 - facing, 2.6);

    // Thin-film colour: it shifts with the angle, the way a soap bubble does.
    float film = facing * 1.35 + p.y * 0.34 + p.x * 0.22 + uTime * 0.045;
    vec3 rainbow = 0.5 + 0.5 * cos(6.2832 * (film + vec3(0.0, 0.33, 0.67)));

    vec3 body = mix(vec3(0.0, 0.3, 0.2), vec3(0.08, 0.98, 0.64), smoothstep(-0.7, 0.9, n.y * 0.65 + n.x * 0.35 + 0.15));
    vec3 surface = mix(body, rainbow * 1.15, 0.28 + 0.72 * rim);

    // Two studio lights, reflected in the glass.
    vec3 bounce = reflect(ray, n);
    float light = smoothstep(0.72, 0.97, bounce.y * 0.82 + bounce.x * 0.38) + 0.55 * smoothstep(0.86, 0.99, -bounce.y * 0.5 - bounce.x * 0.7);
    surface += vec3(0.9, 1.0, 0.96) * light;

    if (eyes(p) < ribbon(p)) {
      vec3 side = vec3(sign(p.x) * EYE.x, EYE.y, 0.0);
      vec3 gaze = normalize(toShield * vec3(uLook * 0.75, 1.0));
      float pupil = smoothstep(0.87, 0.91, dot(normalize(p - side), gaze));
      surface = mix(surface + vec3(0.2), vec3(0.01, 0.03, 0.03), pupil);
    }

    surface = mix(surface, uPulseColor * (0.45 + rim + light), uPulse * 0.62);
    color = mix(color, surface, 0.88 + 0.12 * rim);
  }

  // A verdict's ring, spreading out from the shield.
  float ring = (radius - (1.0 - uPulse) * 0.85) * 16.0;
  color += uPulseColor * exp(-ring * ring) * uPulse * 0.32;

  // A little grain, so the dark gradient doesn't show bands.
  float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  gl_FragColor = vec4(color + (grain - 0.5) / 180.0, 1.0);
}
`;
