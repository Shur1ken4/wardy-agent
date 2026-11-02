import { describe, expect, it } from "vitest";
import { ACCOUNT_CHARACTERS, characterFor, lensStrength, perspective, project, rotate, spherePoints, waveStrength } from "../src/lib/sphere";

const length = ({ x, y, z }: { x: number; y: number; z: number }) => Math.hypot(x, y, z);

describe("the letter sphere's geometry", () => {
  it("every point sits on the sphere", () => {
    for (const point of spherePoints(500)) expect(length(point)).toBeCloseTo(1, 6);
  });

  it("makes as many points as asked, and no two alike", () => {
    const points = spherePoints(300);
    expect(points).toHaveLength(300);
    expect(new Set(points.map(({ x, y, z }) => `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`)).size).toBe(300);
  });

  it("spreads them evenly, with no clumps at the poles: both halves and all sides get a fair share", () => {
    const points = spherePoints(1000);
    for (const axis of ["x", "y", "z"] as const) {
      const above = points.filter((point) => point[axis] > 0).length;
      expect(above).toBeGreaterThan(460);
      expect(above).toBeLessThan(540);
    }
  });

  it("copes with one point", () => {
    expect(spherePoints(1)).toHaveLength(1);
    expect(length(spherePoints(1)[0] as { x: number; y: number; z: number })).toBeCloseTo(1, 6);
  });

  it("uses the characters account names are made of, the same way every time", () => {
    const used = new Set(Array.from({ length: 2000 }, (_, index) => characterFor(index)));
    for (const character of used) expect(ACCOUNT_CHARACTERS).toContain(character);
    expect(used.size).toBe(ACCOUNT_CHARACTERS.length);
    expect(characterFor(7)).toBe(characterFor(7));
  });

  it("turning keeps everything on the sphere, and no turn changes nothing", () => {
    const point = { x: 0.6, y: 0.48, z: 0.64 };
    expect(length(rotate(point, 1.3, -0.7))).toBeCloseTo(1, 6);
    expect(rotate(point, 0, 0)).toEqual(point);
  });

  it("a quarter turn sideways really turns it", () => {
    const turned = rotate({ x: 1, y: 0, z: 0 }, Math.PI / 2, 0);
    expect(turned.x).toBeCloseTo(0, 6);
    expect(Math.abs(turned.z)).toBeCloseTo(1, 6);
  });

  it("nearer letters look bigger, and the centre stays the centre", () => {
    expect(perspective(1)).toBeGreaterThan(perspective(0));
    expect(perspective(0)).toBeGreaterThan(perspective(-1));
    expect(perspective(-1)).toBeGreaterThan(0);
    expect(project({ x: 0, y: 0, z: 1 }, 100, 50, 60)).toMatchObject({ x: 50, y: 60 });
  });
});

describe("a verdict's wave", () => {
  const origin = { x: 0, y: 0, z: 1 };
  const far = { x: 0, y: 0, z: -1 };

  it("starts where it starts, and hasn't reached the far side yet", () => {
    expect(waveStrength(origin, origin, 0.02)).toBeGreaterThan(0.5);
    expect(waveStrength(far, origin, 0.02)).toBe(0);
  });

  it("reaches the far side later, after it has passed the start", () => {
    expect(waveStrength(far, origin, 0.9)).toBeGreaterThan(0);
    expect(waveStrength(origin, origin, 0.9)).toBe(0);
  });

  it("fades as it goes", () => {
    expect(waveStrength(origin, origin, 0.1)).toBeGreaterThan(waveStrength({ x: 1, y: 0, z: 0 }, origin, 0.6));
  });

  it("survives a rounding error at the edge", () => {
    expect(Number.isFinite(waveStrength({ x: 0, y: 0, z: 1.0000001 }, origin, 0.1))).toBe(true);
  });
});

describe("the pointer's lens", () => {
  it("is strongest right under the pointer", () => {
    expect(lensStrength(10, 10, 10, 10, 50)).toBe(1);
  });

  it("fades with distance", () => {
    expect(lensStrength(30, 10, 10, 10, 50)).toBeLessThan(lensStrength(20, 10, 10, 10, 50));
  });

  it("does nothing outside it", () => {
    expect(lensStrength(100, 10, 10, 10, 50)).toBe(0);
  });
});
