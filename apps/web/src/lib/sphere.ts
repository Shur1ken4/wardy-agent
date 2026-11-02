// The geometry behind the letter sphere, with no drawing in it. Points sit evenly on a sphere, turn together, and get
// a screen position and a depth.
export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** The characters NEAR account names are made of, because reading those names is what this product does. */
export const ACCOUNT_CHARACTERS = "abcdefghijklmnopqrstuvwxyz0123456789-_.";

/** Evenly spread points on a unit sphere (the Fibonacci lattice), so there are no clumps at the poles. */
export function spherePoints(count: number): Point3[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: count }, (_, index) => {
    const y = count === 1 ? 0 : 1 - (index / (count - 1)) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const angle = golden * index;
    return { x: Math.cos(angle) * ring, y, z: Math.sin(angle) * ring };
  });
}

/** A repeatable character for each point: the same sphere every time, without looking patterned. */
export function characterFor(index: number): string {
  const mixed = Math.imul(index + 1, 2654435761) >>> 0;
  return ACCOUNT_CHARACTERS[mixed % ACCOUNT_CHARACTERS.length] as string;
}

export function rotate(point: Point3, yaw: number, pitch: number): Point3 {
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const x = point.x * cosY + point.z * sinY;
  const z = point.z * cosY - point.x * sinY;
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  return { x, y: point.y * cosP - z * sinP, z: point.y * sinP + z * cosP };
}

/** How much closer things look when they're nearer. Positive z faces the viewer. */
export function perspective(z: number): number {
  return 1 / (1 - z * 0.28);
}

export function project(point: Point3, radius: number, centerX: number, centerY: number): { x: number; y: number; scale: number } {
  const scale = perspective(point.z);
  return { x: centerX + point.x * radius * scale, y: centerY + point.y * radius * scale, scale };
}

/** How strongly a wave touches a point: 0 before it arrives and after it has passed. */
export function waveStrength(point: Point3, origin: Point3, progress: number): number {
  const distance = Math.acos(Math.max(-1, Math.min(1, point.x * origin.x + point.y * origin.y + point.z * origin.z))) / Math.PI;
  const front = progress * 1.25;
  const behind = front - distance;
  if (behind < 0 || behind > 0.42) return 0;
  return (1 - behind / 0.42) * (1 - progress * 0.55);
}

/** How strongly the pointer lifts a letter: 1 right under it, fading to 0 at the edge of the lens. */
export function lensStrength(x: number, y: number, pointerX: number, pointerY: number, lens: number): number {
  const distance = Math.hypot(x - pointerX, y - pointerY);
  if (distance >= lens) return 0;
  const closeness = 1 - distance / lens;
  return closeness * closeness;
}
