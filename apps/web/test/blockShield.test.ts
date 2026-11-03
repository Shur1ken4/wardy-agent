import { describe, expect, it } from "vitest";
import { blockLevel, eyeBlocks, project, ramp, shieldBlocks, shieldOutline } from "../src/lib/blockShield";

describe("the shield built from blocks", () => {
  const blocks = shieldBlocks();

  it("has enough blocks to read as the shield, and few enough to draw smoothly", () => {
    expect(blocks.length).toBeGreaterThan(1500);
    expect(blocks.length).toBeLessThan(6000);
  });

  it("only places blocks in the band, leaving the middle open for the eyes", () => {
    for (const block of blocks) {
      const edge = shieldOutline(block.x, block.y);
      expect(edge).toBeLessThanOrEqual(-0.02);
      expect(edge).toBeGreaterThanOrEqual(-0.28);
    }
    expect(shieldOutline(0, 0.17)).toBeLessThan(-0.28);
    expect(shieldOutline(2, 0)).toBeGreaterThan(0);
  });

  it("is the same on every load", () => {
    expect(shieldBlocks()).toEqual(blocks);
  });

  it("draws the back layer first, so the front covers it", () => {
    const firstFront = blocks.findIndex((block) => block.z > 0);
    expect(blocks.slice(0, firstFront).every((block) => block.z < 0)).toBe(true);
    expect(blocks.slice(firstFront).every((block) => block.z > 0)).toBe(true);
  });

  it("stays put facing forward, and turns when it looks to the side", () => {
    expect(project(0, 0, 0, 0, 0)).toEqual({ x: 0, y: 0, near: 1.6 / 4.2 });
    expect(project(0, 0, 1, 0.3, 0).x).toBeLessThan(0);
  });

  it("goes from dark to the full colour, and never to white", () => {
    const colors = ramp([0, 0.95, 0.61]);
    expect(colors).toHaveLength(12);
    expect(colors[0]).toBe("rgb(0,39,25)");
    expect(colors.at(-1)).toBe("rgb(0,242,156)");
  });

  it("keeps every block's brightness in range, and the back layer dark, as the light travels", () => {
    for (const time of [0, 1.7, 40, 900]) {
      for (const block of blocks) {
        const level = blockLevel(block, time);
        expect(level).toBeGreaterThanOrEqual(0);
        expect(level).toBeLessThanOrEqual(1);
        if (block.z < 0) expect(level).toBeLessThan(0.35);
      }
    }
  });

  it("moves the light around the outline over time", () => {
    const lit = (time: number) => blocks.filter((block) => block.z > 0 && blockLevel(block, time) > 0.95).map((block) => block.around);
    expect(lit(0).length).toBeGreaterThan(0);
    expect(lit(5)).not.toEqual(lit(0));
  });

  it("gives two eyes that close to one row, and slide toward what they watch", () => {
    const open = eyeBlocks(3, 0, 0);
    expect(open).toHaveLength(66);
    expect(eyeBlocks(1, 0, 0)).toHaveLength(22);
    expect(open.filter((eye) => eye.x < 0)).toHaveLength(33);
    expect(eyeBlocks(3, 1, 0)[0]?.x).toBeGreaterThan(open[0]?.x as number);
    expect(eyeBlocks(3, 0, 1)[0]?.y).toBeGreaterThan(open[0]?.y as number);
    for (const eye of open) expect(shieldOutline(eye.x, eye.y)).toBeLessThan(-0.28);
  });
});
