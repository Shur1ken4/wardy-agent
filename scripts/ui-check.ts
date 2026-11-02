// `npm run test:ui`: opens the real dashboard in a real browser and uses it, the way a person would. It starts its own
// offline server on its own ports, with its own data, so it touches nothing else. It's for what unit tests can't see:
// a hang after a few reloads, a page wider than a phone, an element a screen reader can't name.
//   --shots <folder>   also saves a screenshot of every screen, at desktop and phone width
// Needs Chrome. Set CHROME_PATH if it isn't in the usual place.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const API_PORT = 8797;
const WEB_PORT = 5183;
const BASE = `http://localhost:${WEB_PORT}`;
const CHROME_PLACES = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const flagAt = process.argv.indexOf("--shots");
const shotsDir = flagAt >= 0 ? process.argv[flagAt + 1] : undefined;
const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

let failures = 0;
function check(what: string, passed: boolean, detail = "") {
  console.log(`  ${passed ? "ok  " : "FAIL"}  ${what}${detail ? `: ${detail}` : ""}`);
  if (!passed) failures += 1;
}

function chromePath(): string {
  const found = process.env.CHROME_PATH || CHROME_PLACES.find((place) => existsSync(place));
  if (!found) throw new Error("Chrome wasn't found. Set CHROME_PATH to where it is.");
  return found;
}

async function startServer(dataDir: string): Promise<ChildProcess> {
  const server = spawn(process.execPath, ["--import", "tsx", "scripts/dev.ts"], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", WARDY_MODE: "offline", WARDY_DATA_DIR: dataDir, WARDY_API_PORT: String(API_PORT), WARDY_WEB_PORT: String(WEB_PORT) },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(300);
    if (server.exitCode !== null) throw new Error(`The server stopped with code ${server.exitCode}. Are ports ${API_PORT} and ${WEB_PORT} free?`);
    try {
      if ((await fetch(BASE)).ok && (await fetch(`${BASE}/health`)).ok) return server;
    } catch {
      // Not up yet.
    }
  }
  server.kill();
  throw new Error("The server didn't start in time.");
}

const consoleProblems: string[] = [];

async function newPage(browser: Browser, width: number, height: number, scale: number, label: string): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: scale, isMobile: width < 500, hasTouch: width < 500 });
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("401")) consoleProblems.push(`${label}: ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleProblems.push(`${label}: ${(error as Error).message}`));
  return page;
}

async function goto(page: Page, path: string) {
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.waitForSelector("#main, .approve-main", { timeout: 15_000 });
  await wait(800);
}

const clickText = (page: Page, selector: string, text: string) =>
  page.evaluate(
    (selector, text) => {
      const element = [...document.querySelectorAll<HTMLElement>(selector)].find((candidate) => candidate.textContent?.includes(text));
      if (!element) throw new Error(`There's no ${selector} saying "${text}".`);
      element.click();
    },
    selector,
    text,
  );

const textOf = (page: Page) => page.evaluate(() => document.body.innerText);

/** Everything checked on every screen: it fits, it can be tapped, and a screen reader can use it. */
async function inspect(page: Page, name: string, options: { fullPage?: boolean } = {}) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`${name}: nothing wider than the screen`, overflow <= 0, overflow > 0 ? `${overflow}px too wide` : "");
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, .btn")]
      .filter((element) => element.getClientRects().length > 0 && element.getBoundingClientRect().height < 44)
      .map((element) => element.textContent?.trim().slice(0, 30)),
  );
  check(`${name}: every button is at least 44px tall`, small.length === 0, small.join(", "));
  await page.evaluate(axeSource);
  const violations = await page.evaluate(async () => {
    const { violations: found } = await (window as unknown as { axe: { run(context: Document, options: object): Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { runOnly: ["wcag2a", "wcag2aa"] });
    return found.map(({ id, impact, nodes }) => `${id} (${impact}) on ${nodes[0]?.target.join(" ")}`);
  });
  check(`${name}: no accessibility violations`, violations.length === 0, violations.join("; "));
  if (shotsDir) await page.screenshot({ path: join(shotsDir, `${name}.png`) as `${string}.png`, fullPage: options.fullPage ?? true });
}

async function main() {
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), "wardy-agent-ui-"));
  const server = await startServer(dataDir);
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ["--no-first-run", "--disable-extensions", "--no-sandbox"] });
  try {
    console.log("Reloading again and again");
    {
      const page = await newPage(browser, 1280, 800, 1, "reloads");
      let hung = false;
      for (let attempt = 1; attempt <= 14 && !hung; attempt += 1) {
        try {
          await page.goto(`${BASE}/policy`, { waitUntil: "domcontentloaded", timeout: 8000 });
          await wait(400);
        } catch {
          hung = true;
          check("14 reloads in a row don't hang the dashboard", false, `it hung on reload ${attempt}`);
        }
      }
      if (!hung) check("14 reloads in a row don't hang the dashboard", /Who can spend/.test(await textOf(page)));
      await page.close();
    }

    console.log("Desktop");
    const desktop = await newPage(browser, 1440, 1000, 1.5, "desktop");
    await goto(desktop, "/");
    check("before any traffic, it says what to do next", /Play demo traffic/.test(await textOf(desktop)));
    check("it's labelled as demo data", /Demo data/.test(await textOf(desktop)));
    await inspect(desktop, "desktop-01-live-empty", { fullPage: false });

    await clickText(desktop, "button", "Play demo traffic");
    await desktop.waitForFunction(() => document.querySelectorAll(".feed-row").length >= 9, { timeout: 40_000 });
    await wait(900);
    await desktop.evaluate(() => window.scrollTo(0, 0));
    const tiles = await desktop.evaluate(() => [...document.querySelectorAll<HTMLElement>(".tile-value")].map((tile) => tile.innerText));
    check("the numbers on the tiles came from the traffic", tiles[0] === "9" && tiles[1] === "4" && tiles[2] === "1", tiles.slice(0, 3).join(", "));
    await inspect(desktop, "desktop-02-live-with-traffic");

    await clickText(desktop, ".feed-row", "made to look like");
    await desktop.waitForSelector(".panel");
    await wait(600);
    const panel = await textOf(desktop);
    check("the detail compares the two names", panel.includes("You paid before") && panel.includes("Agent tried to pay"));
    check("the odd character is marked", (await desktop.evaluate(() => document.querySelector(".compare mark")?.textContent)) === "1");
    check("with no AI run, there's no attestation tick", /didn't run/.test(panel));
    await clickText(desktop, ".panel button", "Verify");
    await wait(600);
    check("the signature verifies in the browser", /Valid\. .*Checked in this browser/s.test(await textOf(desktop)));
    await clickText(desktop, ".panel button", "View audit log");
    await wait(500);
    check("the audit chain checks out", /whole chain is intact/.test(await textOf(desktop)));
    await inspect(desktop, "desktop-03-verdict-detail", { fullPage: false });
    await desktop.keyboard.press("Escape");
    await wait(350);
    check("Escape closes the panel", !(await desktop.$(".panel")) && !desktop.url().includes("verdict="));

    await goto(desktop, "/policy");
    check("the policy says who can spend", /Wardy Agent only/.test(await textOf(desktop)));
    await inspect(desktop, "desktop-04-policy");

    await goto(desktop, "/attack-lab");
    await inspect(desktop, "desktop-05-attack-lab-before", { fullPage: false });
    await clickText(desktop, "button", "Run Attack Lab");
    await wait(3000);
    if (shotsDir) await desktop.screenshot({ path: join(shotsDir, "desktop-06-attack-lab-running.png") as `${string}.png` });
    await desktop.waitForFunction(() => /Run again/.test(document.body.innerText), { timeout: 30_000 });
    await wait(900);
    const committed = JSON.parse(readFileSync("apps/attack-lab/results/latest.json", "utf8")) as { totals: { honestPassed: number; honestTotal: number; falseBlocks: number } };
    const totals = await desktop.evaluate(() => [...document.querySelectorAll<HTMLElement>(".totals .tile-value")].map((tile) => tile.innerText));
    check("the lab's totals match the committed results", totals[2] === `${committed.totals.honestPassed} of ${committed.totals.honestTotal}` && totals[3] === String(committed.totals.falseBlocks), totals.join(" | "));
    check("the holdout's misses are on the screen", /attacks still took money/.test(await textOf(desktop)));
    await inspect(desktop, "desktop-07-attack-lab-results");
    await desktop.evaluate(() => document.querySelector<HTMLElement>(".step-chips a")?.click());
    await desktop.waitForSelector(".panel");
    await wait(600);
    check("a lab row opens its verdict", /BLOCK|ALLOW|HOLD/.test(await desktop.evaluate(() => document.querySelector<HTMLElement>(".panel-head")?.innerText ?? "")));
    await desktop.keyboard.press("Escape");

    await goto(desktop, "/network?payee=acme-sh0p.near");
    await wait(500);
    check("an anchored report's proof checks out in the browser", /proof checks out in this browser/.test(await textOf(desktop)));
    check("seed reports say so", /Seeded by Attack Lab/.test(await textOf(desktop)));
    check("the story is there: one attack protects another owner's agent", /Protected by the network/.test(await textOf(desktop)));
    await inspect(desktop, "desktop-08-network");

    await goto(desktop, "/earnings");
    check("earnings say zero, not a made-up number", /Nothing has been sold yet/.test(await textOf(desktop)));
    await inspect(desktop, "desktop-09-earnings");
    await desktop.close();

    console.log("Phone");
    const phone = await newPage(browser, 390, 844, 2, "phone");
    await goto(phone, "/");
    const afterReload = await phone.evaluate(() => [...document.querySelectorAll<HTMLElement>(".tile-value")].map((tile) => tile.innerText));
    check("freshly opened, the tiles show the real numbers, never a false zero", afterReload[0] === "9" && afterReload[1] === "4", afterReload.slice(0, 2).join(", "));
    await inspect(phone, "phone-01-live", { fullPage: false });
    await phone.evaluate(() => document.querySelector(".feed-list")?.scrollIntoView());
    await wait(200);
    if (shotsDir) await phone.screenshot({ path: join(shotsDir, "phone-02-live-feed.png") as `${string}.png` });
    await clickText(phone, ".feed-row", "made to look like");
    await phone.waitForSelector(".panel");
    await wait(600);
    await inspect(phone, "phone-03-verdict-detail", { fullPage: false });
    await phone.keyboard.press("Escape");
    await goto(phone, "/policy");
    await inspect(phone, "phone-04-policy");
    await goto(phone, "/attack-lab");
    await clickText(phone, "button", "Run Attack Lab");
    await phone.waitForFunction(() => /Run again/.test(document.body.innerText), { timeout: 30_000 });
    await wait(900);
    await inspect(phone, "phone-05-attack-lab");
    await goto(phone, "/network?payee=acme-sh0p.near");
    await inspect(phone, "phone-06-network");
    await goto(phone, "/earnings");
    await inspect(phone, "phone-07-earnings");

    await goto(phone, "/");
    await clickText(phone, "button", "Review");
    await phone.waitForSelector(".approve-card", { timeout: 10_000 });
    await wait(500);
    check("the approval link's token is gone from the address bar", !phone.url().includes("token"));
    check("the phone asks the right question", /Pay acme-shop\.near 2.NEAR again\?/.test(await textOf(phone)));
    await inspect(phone, "phone-08-approve", { fullPage: false });
    await clickText(phone, ".approve-actions button", "Reject");
    await phone.waitForSelector(".approve-result", { timeout: 10_000 });
    await wait(500);
    check("rejecting says nothing was paid", /Nothing was paid/.test(await textOf(phone)));
    await inspect(phone, "phone-09-approve-result", { fullPage: false });
    await phone.reload({ waitUntil: "domcontentloaded" });
    await phone.waitForSelector(".approve-result", { timeout: 10_000 });
    check("a reload shows the same result, and can't decide twice", !(await phone.$(".approve-actions")));
    await phone.close();

    console.log("Reduced motion");
    const calm = await newPage(browser, 1280, 900, 1, "reduced-motion");
    await calm.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await goto(calm, "/");
    check("the background doesn't drift", (await calm.evaluate(() => getComputedStyle(document.querySelector(".hero") as Element, "::before").animationName)) === "none");
    await goto(calm, "/attack-lab");
    const started = Date.now();
    await clickText(calm, "button", "Run Attack Lab");
    await calm.waitForFunction(() => /Run again/.test(document.body.innerText), { timeout: 30_000 });
    check("the lab's rows aren't held back for effect", Date.now() - started < 4000, `${Date.now() - started}ms`);
    await calm.close();

    check("no errors in the browser console", consoleProblems.length === 0, consoleProblems.slice(0, 5).join("; "));
  } finally {
    await browser.close();
    server.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().then(
  () => {
    console.log(failures === 0 ? "\nEverything checked passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  },
  (error) => {
    console.error((error as Error).message);
    process.exit(1);
  },
);
