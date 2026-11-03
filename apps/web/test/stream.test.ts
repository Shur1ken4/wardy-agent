import { describe, expect, it } from "vitest";
import { PULSE_MS, pulseStrength, veilOpacity } from "../src/lib/backdrop";
import { dots, funnel, GATE_AT, pushFrom, SETTLE_MS, tokenAt, TRAVEL_MS, VERDICT_MS } from "../src/lib/stream";

describe("a payment at the gate", () => {
  it("reaches the gate before anything is decided", () => {
    expect(tokenAt("ALLOW", 0)).toMatchObject({ x: 0, decided: false });
    expect(tokenAt("BLOCK", TRAVEL_MS - 1)?.decided).toBe(false);
    expect(tokenAt("BLOCK", TRAVEL_MS - 1)?.x).toBeCloseTo(GATE_AT, 3);
  });

  it("only an ALLOW ever gets past it", () => {
    const late = TRAVEL_MS + SETTLE_MS * 0.9;
    expect(tokenAt("ALLOW", late)?.x).toBeGreaterThan(GATE_AT);
    expect(tokenAt("HOLD", late)?.x).toBe(GATE_AT);
    expect(tokenAt("BLOCK", late)?.x).toBeLessThan(GATE_AT);
  });

  it("is gone when its moment is over", () => {
    expect(tokenAt("ALLOW", VERDICT_MS)).toBeNull();
    expect(tokenAt("ALLOW", -1)).toBeNull();
  });
});

describe("the flow", () => {
  it("narrows through the gate", () => {
    expect(funnel(GATE_AT)).toBeLessThan(funnel(0.1));
    expect(funnel(0)).toBeCloseTo(1);
    expect(funnel(1)).toBeCloseTo(1);
  });

  it("is pushed away from the pointer, and only nearby", () => {
    expect(pushFrom(110, 100, 100, 100, 50).x).toBeGreaterThan(0);
    expect(pushFrom(90, 100, 100, 100, 50).x).toBeLessThan(0);
    expect(pushFrom(300, 100, 100, 100, 50)).toEqual({ x: 0, y: 0 });
    expect(Number.isFinite(pushFrom(100, 100, 100, 100, 50).y)).toBe(true);
  });

  it("looks the same on every load", () => {
    expect(dots(20)).toEqual(dots(20));
  });
});

describe("the background", () => {
  it("a verdict's light fades out completely", () => {
    expect(pulseStrength(0)).toBe(1);
    expect(pulseStrength(PULSE_MS / 2)).toBeLessThan(1);
    expect(pulseStrength(PULSE_MS)).toBe(0);
    expect(pulseStrength(-5)).toBe(0);
  });

  it("darkens as you scroll, and on every page but the first", () => {
    expect(veilOpacity(0, 900, false)).toBe(0);
    expect(veilOpacity(0, 900, true)).toBeGreaterThan(0.4);
    expect(veilOpacity(5000, 900, false)).toBeCloseTo(0.8);
    expect(veilOpacity(5000, 900, true)).toBeCloseTo(0.8);
  });
});
