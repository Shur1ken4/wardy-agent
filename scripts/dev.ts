// `npm run dev`: the API and the dashboard together. Offline by default, so it works with no setup: demo data, mock
// ledgers, no keys and no network. The MCP server isn't started here, because an AI agent launches it for itself (see
// docs/MCP_SETUP.md).
//   --fresh    starts the offline demo from nothing
//   --lan      lets a phone on your Wi-Fi open the dashboard and approval page
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SEED_FEED_FILE } from "@wardy-agent/attack-lab";
import { buildApp, wire } from "@wardy-agent/api";
import { parseFeed } from "@wardy-agent/core";
import { createServer } from "vite";
import { demoTools } from "./demo-tools.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const WEB_ROOT = fileURLToPath(new URL("../apps/web/", import.meta.url));
const host = process.env.WARDY_API_HOST || "127.0.0.1";
const port = Number(process.env.WARDY_API_PORT || 8787);
const webPort = Number(process.env.WARDY_WEB_PORT || 5173);
const lan = process.argv.includes("--lan");

function lanAddress(): string | undefined {
  return Object.values(networkInterfaces())
    .flat()
    .find((address) => address && address.family === "IPv4" && !address.internal)?.address;
}

function assertPortFree(port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", () => reject(new Error(`Wardy Agent is already running on port ${port}, so nothing was cleared. Stop it first, then run this again.`)));
    probe.listen(port, host, () => probe.close(() => resolve()));
  });
}

try {
  const mode = process.env.WARDY_MODE || "offline";
  // Your Wi-Fi isn't encrypted to this server, and live mode's credential guards real money.
  if (lan && mode === "live") throw new Error("--lan won't run in live mode. Use it offline or on testnet.");
  if (process.argv.includes("--fresh")) {
    if (mode !== "offline") throw new Error("--fresh only clears the offline demo. It won't touch testnet or live data.");
    // Before clearing anything: a copy that's already running would lose its data, and this one couldn't start anyway.
    await assertPortFree(port, host);
    rmSync(process.env.WARDY_DATA_DIR || join(".data", "offline"), { recursive: true, force: true });
  }

  const webUrl = process.env.WARDY_WEB_URL || `http://${lan ? (lanAddress() ?? "localhost") : "localhost"}:${webPort}`;
  const wiring = await wire({ ...process.env, WARDY_WEB_URL: webUrl });
  const { service } = wiring;

  // So the Network screen has anchored reports to show. They're labelled as seed, and only count offline.
  if (wiring.mode === "offline") wiring.reports.merge(parseFeed(readFileSync(SEED_FEED_FILE, "utf8")));
  const demo = demoTools(wiring, (request) => app.inject(request));

  const app = await buildApp({
    service,
    network: wiring.network,
    reporting: wiring.reporting,
    agentToken: wiring.agentToken,
    ownerToken: wiring.ownerToken,
    mode: wiring.mode,
    corsOrigins: [webUrl, `http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`],
    ...(demo ? { demo } : {}),
    logger: {
      level: "warn",
      // The route, not the URL: nothing a caller put in a URL ends up in a log.
      serializers: { req: (request: { method: string; routeOptions?: { url?: string } }) => ({ method: request.method, route: request.routeOptions?.url }) },
    },
  });

  service.on("hold", ({ verdict, approvalUrl, expiresAt }) => {
    console.log(`\nHOLD ${verdict.amount} to ${verdict.payee}: ${verdict.reasons[0]}`);
    // A link carrying a token doesn't belong in a live server's output.
    if (wiring.mode === "live") console.log(`Waiting for the owner. Verdict ${verdict.verdictId}, expires ${expiresAt}.`);
    else console.log(`Owner, decide here: ${approvalUrl}`);
  });

  await app.listen({ host, port });

  const web = await createServer({
    root: WEB_ROOT,
    configFile: join(WEB_ROOT, "vite.config.ts"),
    logLevel: "warn",
    server: { port: webPort, strictPort: true, host: lan ? "0.0.0.0" : "localhost", proxy: { "/v1": `http://${host}:${port}`, "/health": `http://${host}:${port}`, "/llms.txt": `http://${host}:${port}` } },
  });
  await web.listen();

  const expiry = setInterval(() => service.expireHolds(), 60_000);
  const stop = async () => {
    clearInterval(expiry);
    await web.close();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`\nWardy Agent is running (${wiring.mode}, custody: ${service.providerName}).`);
  console.log(`  Dashboard: ${webUrl}`);
  console.log(`  API:       http://${host}:${port}`);
  console.log(`  For agents: http://${host}:${port}/llms.txt, or docs/MCP_SETUP.md`);
  if (lan) console.log("  On your Wi-Fi: anyone on this network can open the dashboard. Stop it when you're done.");
  if (wiring.mode === "offline") {
    console.log("\nDemo data. No keys, no funds, no network. Credentials are the public offline ones.");
    console.log(`  Agent: ${wiring.agentToken}   Owner: ${wiring.ownerToken}`);
  } else if (wiring.mode === "testnet") {
    console.log(`\nFree test tokens only. Credentials are in ${wiring.dataDir}/secrets.json.`);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
