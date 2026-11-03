// The shield as a crowd of small blocks, the same blocks the checkpoint's payments are drawn with. The outline is the
// formula the glass shield uses, so it's the same shape. Kept apart from the drawing so it can be tested.

export interface Block {
  x: number;
  y: number;
  z: number;
  /** 0 to 1 around the outline, so a run of light can travel along it. */
  around: number;
  /** A fixed scatter value, 0 to 1. */
  seed: number;
}

const scatter = (a: number, b: number) => {
  const value = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return value - Math.floor(value);
};

/** Negative inside the shield, positive outside. */
export function shieldOutline(x: number, y: number): number {
  const a = Math.sqrt(x * x + 0.0003);
  const side = y < 0.05 ? Math.hypot(a + 0.3965, y - 0.05) - 1.2165 : a - 0.82;
  const top = (a * 0.33 + (y - 1) * 0.944);
  const h = Math.max(0.08 - Math.abs(side - top), 0) / 0.08;
  return Math.max(side, top) + h * h * 0.02;
}

/** The band of the shield, as a grid of blocks on a back and a front layer. The back comes first, so the front draws over it. */
export function shieldBlocks(spacing = 0.03): Block[] {
  const back: Block[] = [];
  const front: Block[] = [];
  for (let gridY = -1.3; gridY <= 1.1; gridY += spacing) {
    for (let gridX = -0.95; gridX <= 0.95; gridX += spacing) {
      const edge = shieldOutline(gridX, gridY);
      if (edge > -0.02 || edge < -0.28) continue;
      const seed = scatter(gridX, gridY);
      const around = Math.atan2(gridY + 0.1, gridX) / (Math.PI * 2) + 0.5;
      // Rounded, so the band has a shape from the side: the middle stands further forward than its edges.
      const depth = 0.03 + 0.09 * Math.sqrt(Math.max(0, 1 - ((edge + 0.15) / 0.13) ** 2));
      back.push({ x: gridX, y: gridY, z: -depth, around, seed });
      front.push({ x: gridX, y: gridY, z: depth, around, seed });
    }
  }
  return [...back, ...front];
}

/** Where a point in the shield's space lands on screen, for the same slow turn the glass shield makes. */
export function project(x: number, y: number, z: number, yaw: number, pitch: number): { x: number; y: number; near: number } {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const x1 = cy * x - sy * z;
  const z1 = sy * x + cy * z;
  const y2 = cp * y + sp * z1;
  const z2 = -sp * y + cp * z1;
  const near = 1.6 / (4.2 - z2);
  return { x: x1 * near, y: y2 * near, near };
}

/** One colour from dark to its full brightness, as `steps` CSS strings. It never washes out to white. */
export function ramp(color: [number, number, number], steps = 12): string[] {
  return Array.from({ length: steps }, (_unused, index) => {
    const level = index / (steps - 1);
    const mix = (channel: number) => {
      return Math.round(channel * (0.16 + level * 0.84) * 255);
    };
    return `rgb(${mix(color[0])},${mix(color[1])},${mix(color[2])})`;
  });
}

/** How bright a block is, 0 to 1. Lit from the upper right, with two runs of light travelling around the outline. */
export function blockLevel(block: Block, time: number): number {
  const shape = 0.3 + 0.32 * (block.y * 0.55 + block.x * 0.25 + 0.5);
  if (block.z < 0) return Math.max(0, Math.min(1, shape * 0.32));
  const run = (block.around - time * 0.07 + 10) % 1;
  const secondRun = (block.around - time * 0.07 + 10.5) % 1;
  const light = Math.max(run < 0.09 ? 1 - run / 0.09 : 0, secondRun < 0.05 ? 1 - secondRun / 0.05 : 0);
  const sparkle = (block.seed * 37 + time * 0.5) % 1 < 0.012 ? 0.5 : 0;
  return Math.max(0, Math.min(1, shape + light * 0.7 + sparkle));
}

export const EYE_SPACING = 0.03;

/** Two calm slits, tilted slightly inward. They slide toward what they're watching, and `rows` is how open they are. */
export function eyeBlocks(rows: number, lookX: number, lookY: number): { x: number; y: number }[] {
  const blocks: { x: number; y: number }[] = [];
  for (const side of [-1, 1]) {
    for (let column = -5; column <= 5; column += 1) {
      for (let row = 0; row < rows; row += 1) {
        blocks.push({
          x: side * 0.26 + column * EYE_SPACING + lookX * 0.075,
          y: 0.17 + (row - (rows - 1) / 2) * EYE_SPACING + side * column * EYE_SPACING * 0.07 + lookY * 0.06,
        });
      }
    }
  }
  return blocks;
}
