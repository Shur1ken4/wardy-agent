// Draws the X profile picture and top banner with the same shield and checkpoint the dashboard uses, so they always match.
//   npx tsx scripts/render-x-images.ts
// Writes docs/brand/x-profile.png and docs/brand/x-banner.png. Needs Chrome. Set CHROME_PATH if it isn't in the usual place.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import { FRAGMENT_SHADER, VERTEX_SHADER } from "../apps/web/src/lib/backdrop.js";
import { dots, funnel } from "../apps/web/src/lib/stream.js";

const CHROME_PLACES = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"];
const chrome = process.env.CHROME_PATH || CHROME_PLACES.find((place) => existsSync(place));
if (!chrome) throw new Error("Chrome wasn't found. Set CHROME_PATH to where it is.");

const out = resolve("docs/brand");
mkdirSync(out, { recursive: true });
const font = (name: string) => pathToFileURL(resolve(`node_modules/@fontsource-variable/${name}/files/${name}-latin-wght-normal.woff2`)).href;

// A still moment of the animation, turned a little so the glass catches the light.
const STILL_TIME = 24.9;
const SHIELD_HALF_WIDTH = 142;

function page(width: number, height: number, zoom: number, shift: number, overlay: string): string {
  const shader = FRAGMENT_SHADER.replace("min(uSize.y, uSize.x * 1.15)", `(min(uSize.y, uSize.x * 1.15) * ${zoom.toFixed(3)})`);
  return `<!doctype html><meta charset="utf-8"><style>
    @font-face { font-family: Head; src: url("${font("space-grotesk")}"); font-weight: 300 700; }
    @font-face { font-family: Code; src: url("${font("jetbrains-mono")}"); font-weight: 100 800; }
    html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: #050809; }
    canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
    .text { position: absolute; color: #f1f5f2; font-family: Head; }
  </style>
  <canvas id="glass"></canvas><canvas id="flow"></canvas>${overlay}
  <script>
    const canvas = document.getElementById("glass");
    canvas.width = ${width * 2}; canvas.height = ${height * 2};
    const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true });
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, ${JSON.stringify(VERTEX_SHADER)}], [gl.FRAGMENT_SHADER, ${JSON.stringify(shader)}]]) {
      const part = gl.createShader(type); gl.shaderSource(part, source); gl.compileShader(part); gl.attachShader(program, part);
    }
    gl.linkProgram(program); gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const at = gl.getAttribLocation(program, "corner");
    gl.enableVertexAttribArray(at); gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
    const u = (name) => gl.getUniformLocation(program, name);
    gl.uniform2f(u("uSize"), canvas.width, canvas.height);
    gl.uniform1f(u("uTime"), ${STILL_TIME});
    gl.uniform2f(u("uLook"), 0, 0);
    gl.uniform1f(u("uPulse"), 0);
    gl.uniform3f(u("uPulseColor"), 0, 0.95, 0.61);
    gl.uniform1f(u("uShift"), ${shift});
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    window.linked = gl.getProgramParameter(program, gl.LINK_STATUS);
  </script>`;
}

/** The checkpoint's flow, converging on the shield at `gateX`. Plain rectangles, drawn into the banner's own canvas. */
function bannerFlow(width: number, height: number, gateX: number): string {
  const centerY = height / 2 + 6;
  const rects = dots(620).map((dot, index) => {
    const across = (dot.start + index * 0.013) % 1;
    const x = across < 0.5 ? (across / 0.5) * gateX : gateX + ((across - 0.5) / 0.5) * (width - gateX);
    const y = centerY + dot.lane * height * 0.46 * funnel(across);
    return { x, y, size: dot.size * 1.15, checked: across > 0.5, alpha: Math.min(1, Math.min(across, 1 - across) * 10) };
  }).filter((dot) => Math.abs(dot.x - gateX) > SHIELD_HALF_WIDTH);
  // One payment that was blocked: it broke against the shield's left edge, and the pieces fly back.
  const sparks = Array.from({ length: 16 }, (_unused, spark) => {
    const angle = Math.PI * 0.72 + (spark / 15) * Math.PI * 0.56;
    const distance = 22 + ((spark * 7) % 5) * 15;
    return { x: gateX - SHIELD_HALF_WIDTH - 8 + Math.cos(angle) * distance, y: centerY + Math.sin(angle) * distance, size: 2.4 };
  });
  return `<script>
    const flow = document.getElementById("flow");
    flow.width = ${width * 2}; flow.height = ${height * 2};
    const context = flow.getContext("2d");
    context.scale(2, 2);
    for (const r of ${JSON.stringify(rects)}) {
      context.globalAlpha = r.alpha * (r.checked ? 0.8 : 0.34);
      context.fillStyle = r.checked ? "#00f29b" : "#c6d2cd";
      context.fillRect(r.x - r.size, r.y - r.size, r.size * 2, r.size * 2);
    }
    context.fillStyle = "#ff5a1f";
    context.shadowColor = "#ff5a1f";
    context.shadowBlur = 10;
    for (const r of ${JSON.stringify(sparks)}) {
      context.globalAlpha = 0.95;
      context.fillRect(r.x - r.size, r.y - r.size, r.size * 2, r.size * 2);
    }
  </script>`;
}

const BANNER = { width: 1500, height: 500, gateX: 1225, zoom: 0.87 };
// X's profile picture covers the banner's lower left, up to about x = 375, so the words start after it.
const bannerText = `
  <div style="position:absolute; left:320px; top:0; width:700px; height:500px; background:radial-gradient(closest-side, rgba(5,8,9,.86), rgba(5,8,9,.62) 65%, transparent)"></div>
  <div class="text" style="left:396px; top:122px; width:600px;">
    <div style="font:500 20px Code; color:#3df2b0; letter-spacing:.01em">Wardy Agent</div>
    <div style="font:500 58px/1.05 Head; letter-spacing:-.035em; margin-top:14px">Every payment your agents make is checked first.</div>
    <div style="font:400 22px Head; color:#d3ddd9; margin-top:18px">A payment firewall for AI agents on NEAR</div>
  </div>`;

// How the two look together, on a profile and as a tiny icon. Only to look at: it doesn't get uploaded.
const previewPage = `<!doctype html><meta charset="utf-8"><style>
  @font-face { font-family: Head; src: url("${font("space-grotesk")}"); font-weight: 300 700; }
  body { margin: 0; width: 600px; height: 330px; background: #000; color: #e7e9ea; font-family: Head; position: relative; overflow: hidden; }
  img { display: block; }
</style>
<img src="x-banner.png" style="width:600px; height:200px">
<img src="x-profile.png" style="position:absolute; left:16px; top:134px; width:133px; height:133px; border-radius:50%; border:4px solid #000">
<div style="position:absolute; left:16px; top:278px; font-size:20px; font-weight:700">Wardy Agent</div>
<img src="x-profile.png" style="position:absolute; right:60px; top:222px; width:48px; height:48px; border-radius:50%">
<img src="x-profile.png" style="position:absolute; right:20px; top:230px; width:32px; height:32px; border-radius:50%">`;

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--allow-file-access-from-files"] });
try {
  const render = async (name: string, width: number, height: number, html: string) => {
    const file = resolve(out, `.${name}.html`);
    writeFileSync(file, html);
    const tab = await browser.newPage();
    await tab.setViewport({ width, height, deviceScaleFactor: 2 });
    await tab.goto(pathToFileURL(file).href, { waitUntil: "networkidle0", timeout: 120_000 });
    await tab.evaluate("document.fonts.ready");
    if (!(await tab.evaluate("window.linked"))) throw new Error("The shader didn't compile.");
    await tab.screenshot({ path: resolve(out, `${name}.png`) as `${string}.png` });
    await tab.close();
    rmSync(file);
    console.log(`Wrote docs/brand/${name}.png`);
  };
  // A smaller shield than the first try: X crops the picture to a circle, and its corners have to stay inside.
  await render("x-profile", 500, 500, page(500, 500, 0.9, 0, ""));
  const shift = (BANNER.gateX - BANNER.width / 2) / (BANNER.height * BANNER.zoom);
  await render("x-banner", BANNER.width, BANNER.height, page(BANNER.width, BANNER.height, BANNER.zoom, shift, bannerFlow(BANNER.width, BANNER.height, BANNER.gateX) + bannerText));
  writeFileSync(resolve(out, ".preview.html"), previewPage);
  const tab = await browser.newPage();
  await tab.setViewport({ width: 600, height: 330, deviceScaleFactor: 2 });
  await tab.goto(pathToFileURL(resolve(out, ".preview.html")).href, { waitUntil: "networkidle0" });
  await tab.screenshot({ path: resolve(out, "x-preview.png") as `${string}.png` });
  rmSync(resolve(out, ".preview.html"));
} finally {
  await browser.close();
}
