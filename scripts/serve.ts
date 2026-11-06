// `npm run serve`: the hosted server. The dashboard and the API on one port, for a server on the internet. It never
// holds a mainnet key and refuses to start if one is set, because anyone can reach it. Build the dashboard first:
// `npm run build:web`.
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildApp } from "@wardy-agent/api";
import { HostedTenancy } from "./hosted.js";

const MAINNET_SETTINGS = ["NEAR_INTENTS_AGENT_API_KEY", "WARDY_GRANT_TOKEN", "WARDY_AGENT_ID", "AGENT_OWNER_PRIVATE_KEY"];
const DIST = fileURLToPath(new URL("../apps/web/dist/", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};
// Same origin only. The one outside call is the button that reads the Network root from NEAR testnet.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  // The build inlines its smallest font files as data: URLs.
  "font-src 'self' data:",
  "connect-src 'self' https://test.rpc.fastnear.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

export function assertNoMainnetKeys(env: NodeJS.ProcessEnv) {
  if (env.WARDY_MODE === "live") throw new Error("The hosted server won't run live mode. Real money stays on your own computer.");
  const found = MAINNET_SETTINGS.filter((name) => env[name]);
  if (found.length > 0) throw new Error(`The hosted server won't start with mainnet settings present: ${found.join(", ")}. Remove them from its environment.`);
}

/** A file from the built dashboard, or undefined. Never outside it, whatever the path says. */
export function staticFile(urlPath: string, root = DIST): string | undefined {
  const clean = normalize(decodeURIComponent(urlPath.split("?")[0] ?? "/")).replace(/^([/\\])+/, "");
  const path = join(root, clean);
  if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) return undefined;
  return existsSync(path) && statSync(path).isFile() ? path : undefined;
}

export async function buildHostedApp({ dataRoot, webUrl, indexHtml, dist = DIST }: { dataRoot: string; webUrl: string; indexHtml: string; dist?: string }) {
  const tenancy = await HostedTenancy.create({ dataRoot, webUrl });
  const fallback = tenancy.fallback();
  const app = await buildApp({
    service: fallback.service,
    network: tenancy.network,
    // Unused with a tenancy, but random, so nothing opens the public tenant as an owner.
    agentToken: randomBytes(24).toString("hex"),
    ownerToken: randomBytes(24).toString("hex"),
    mode: "offline",
    tenancy,
    trustProxy: true,
    corsOrigins: [webUrl],
    indexHtml: () => indexHtml,
    logger: { level: "warn", serializers: { req: (request: { method: string; routeOptions?: { url?: string } }) => ({ method: request.method, route: request.routeOptions?.url }) } },
    extend: (server) => {
      server.addHook("onSend", async (_request, reply, payload) => {
        reply.header("x-content-type-options", "nosniff");
        reply.header("referrer-policy", "no-referrer");
        reply.header("x-frame-options", "DENY");
        reply.header("strict-transport-security", "max-age=31536000");
        reply.header("content-security-policy", CSP);
        return payload;
      });

      // A visitor's own sandbox. Limited, so nobody can make thousands of them.
      server.post("/v1/sandbox", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async () => tenancy.createSandbox());

      // The dashboard's files, and its own pages, such as /approve/..., which the browser router draws.
      server.setNotFoundHandler(async (request, reply) => {
        const path = request.url.split("?")[0] ?? "/";
        if (request.method !== "GET" || path.startsWith("/v1/")) return reply.status(404).send({ error: "not_found", message: "No such route." });
        const file = staticFile(path, dist);
        if (!file) return reply.type("text/html; charset=utf-8").send(indexHtml);
        if (path.startsWith("/assets/")) reply.header("cache-control", "public, max-age=31536000, immutable");
        return reply.type(TYPES[extname(file)] ?? "application/octet-stream").send(readFileSync(file));
      });
    },
  });
  tenancy.setInject((request) => app.inject(request));
  return { app, tenancy };
}

async function main() {
  assertNoMainnetKeys(process.env);
  if (!existsSync(join(DIST, "index.html"))) throw new Error("The dashboard isn't built. Run: npm run build:web");
  const port = Number(process.env.PORT || 8080);
  const webUrl = (process.env.WARDY_PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, "");
  const { app, tenancy } = await buildHostedApp({
    dataRoot: process.env.WARDY_DATA_DIR || join(".data", "hosted"),
    webUrl,
    indexHtml: readFileSync(join(DIST, "index.html"), "utf8"),
  });

  const sweep = setInterval(() => tenancy.sweep(), 10 * 60_000);
  const stop = async () => {
    clearInterval(sweep);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await app.listen({ host: process.env.HOST || "0.0.0.0", port });
  console.log(`Wardy Agent hosted server on ${webUrl} (port ${port}). Visitors get their own offline sandbox.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}
