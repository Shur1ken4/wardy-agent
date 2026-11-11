// Draws the dashboard's icons from the one shield SVG, so the tab icon, the home-screen icon and the link preview all
// match. Writes into apps/web/public. Needs Chrome: set CHROME_PATH if it isn't in the usual place.
//   npx tsx scripts/render-icons.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import puppeteer from "puppeteer-core";

const CHROME_PLACES = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"];
const chrome = process.env.CHROME_PATH || CHROME_PLACES.find((place) => existsSync(place));
if (!chrome) throw new Error("Chrome wasn't found. Set CHROME_PATH to where it is.");

const out = resolve("apps/web/public");
const shield = readFileSync(resolve(out, "shield.svg"), "utf8");

/** The shield on the dashboard's dark background, with room around it, as home-screen icons expect. */
function icon(size: number, padded: boolean): string {
  const inset = padded ? Math.round(size * 0.18) : 0;
  return `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; width: ${size}px; height: ${size}px; overflow: hidden; background: ${padded ? "#050809" : "transparent"}; }
    svg { position: absolute; left: ${inset}px; top: ${inset}px; width: ${size - inset * 2}px; height: ${size - inset * 2}px; }
  </style>${shield}`;
}

const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
try {
  const page = await browser.newPage();
  for (const [name, size, padded] of [["favicon-32.png", 32, false], ["icon-192.png", 192, true], ["icon-512.png", 512, true], ["apple-touch-icon.png", 180, true]] as const) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(icon(size, padded));
    writeFileSync(resolve(out, name), await page.screenshot({ type: "png", omitBackground: !padded }));
    console.log(`wrote apps/web/public/${name}`);
  }
} finally {
  await browser.close();
}
