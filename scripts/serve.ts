// `npm run serve`: the hosted server. The dashboard and the API on one port, for a server on the internet. It never
// holds a mainnet key and refuses to start if one is set, because anyone can reach it. Build the dashboard first:
// `npm run build:web`.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildApp } from "@wardy-agent/api";
import { generateSigningKey, ServiceError } from "@wardy-agent/core";
import { MockChainData, NearAiContextAnalyzer, NearChainData, OFFLINE_ACCOUNTS, OutLayerCustody } from "@wardy-agent/providers";
import type { FastifyRequest } from "fastify";
import { SignInBody, SignInError, WalletSignIn } from "./auth.js";
import { DailyCappedAnalyzer, DemoOrChainData, HostedTenancy, type HostedOwners, PoolDailyCap } from "./hosted.js";
import { startMarketLoop } from "./market-loop.js";

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
// Same origin, plus NEAR RPC (the Network root, and the wallet at sign-in) and Meteor's wallet, which signs in a popup.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  // The build inlines its smallest font files as data: URLs.
  "font-src 'self' data:",
  "connect-src 'self' https://test.rpc.fastnear.com https://free.rpc.fastnear.com https://mw.rpc.fastnear.com https://wallet.meteorwallet.app",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

export function assertNoMainnetKeys(env: NodeJS.ProcessEnv) {
  if (env.WARDY_MODE === "live") throw new Error("The hosted server won't run live mode. Real money stays on your own computer.");
  const found = MAINNET_SETTINGS.filter((name) => env[name]);
  if (found.length > 0) throw new Error(`The hosted server won't start with mainnet settings present: ${found.join(", ")}. Remove them from its environment.`);
  // The key that signed real mainnet verdicts must not also sign whatever strangers do here, or their verdicts would look
  // like ours. The server makes its own key and keeps it with its data.
  if (env.WARDY_SIGNING_KEY) throw new Error("The hosted server makes its own signing key. Remove WARDY_SIGNING_KEY from its environment.");
}

/** A file from the built dashboard, or undefined. Never outside it, whatever the path says. */
export function staticFile(urlPath: string, root = DIST): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  } catch {
    return undefined; // A broken %-escape names no file.
  }
  if (decoded.includes("\0")) return undefined;
  const clean = normalize(decoded).replace(/^([/\\])+/, "");
  const path = join(root, clean);
  if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) return undefined;
  return existsSync(path) && statSync(path).isFile() ? path : undefined;
}

const bearerOf = (request: FastifyRequest) => {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
};

export interface HostedAppOptions {
  dataRoot: string;
  webUrl: string;
  indexHtml: string;
  dist?: string;
  owners?: HostedOwners;
  /** How many proxies stand in front, such as Fly.io's one. Only their X-Forwarded-For entries are believed. */
  proxyHops?: number;
  /** New accounts one address may sign up in a day, so free testnet accounts can't fill the server. */
  signUpsPerAddressPerDay?: number;
  now?: () => number;
}

export async function buildHostedApp({ dataRoot, webUrl, indexHtml, dist = DIST, owners, proxyHops = 1, signUpsPerAddressPerDay = 3, now = Date.now }: HostedAppOptions) {
  const tenancy = await HostedTenancy.create({ dataRoot, webUrl, ...(owners ? { owners } : {}) });
  const fallback = tenancy.fallback();
  const app = await buildApp({
    service: fallback.service,
    network: tenancy.network,
    // Unused with a tenancy, but random, so nothing opens the public tenant as an owner.
    agentToken: randomBytes(24).toString("hex"),
    ownerToken: randomBytes(24).toString("hex"),
    mode: "offline",
    tenancy,
    trustProxy: proxyHops,
    maxStreamsPerOwner: 5,
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
      server.post("/v1/sandbox", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => tenancy.createSandbox(request.ip));

      // Who this credential is, so the dashboard can say "signed in as" or offer sign-in.
      server.get("/v1/me", async (request) => {
        const who = tenancy.whoIs(bearerOf(request));
        if (!who) throw new ServiceError(401, "unauthorized", "Missing or wrong credential.");
        return { ...who, signInAvailable: Boolean(owners) };
      });

      // A new token for the owner's agents, shown once. The old one stops working.
      server.post("/v1/agent-token", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => {
        const agentToken = tenancy.newAgentToken(bearerOf(request));
        if (!agentToken) throw new ServiceError(401, "unauthorized", "Missing or wrong credential.");
        return { agentToken };
      });

      if (owners) {
        let signUps = { day: "", byAddress: new Map<string, number>() };
        server.post("/v1/auth/challenge", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async () => {
          try {
            return owners.signIn.challenge();
          } catch (error) {
            throw new ServiceError(503, "busy", (error as Error).message);
          }
        });

        server.post("/v1/auth/verify", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => {
          const input = SignInBody.parse(request.body);
          let session: Awaited<ReturnType<typeof owners.signIn.verify>>;
          try {
            session = await owners.signIn.verify(input);
          } catch (error) {
            if (error instanceof SignInError) throw new ServiceError(401, "sign_in_failed", error.message);
            throw error;
          }
          try {
            if (!tenancy.hasOwner(session.ownerId)) {
              const day = new Date(now()).toISOString().slice(0, 10);
              if (signUps.day !== day) signUps = { day, byAddress: new Map() };
              const made = signUps.byAddress.get(request.ip) ?? 0;
              if (made >= signUpsPerAddressPerDay) throw new Error("Too many new accounts from your network today. Try again tomorrow.");
              signUps.byAddress.set(request.ip, made + 1);
            }
            await tenancy.ensureOwner(session.ownerId);
          } catch (error) {
            owners.signIn.logout(session.sessionToken);
            throw new ServiceError(503, "full", (error as Error).message);
          }
          return session;
        });

        server.post("/v1/auth/logout", async (request) => {
          owners.signIn.logout(bearerOf(request));
          return { signedOut: true };
        });
      }

      // The dashboard's files, and its own pages, such as /approve/..., which the browser router draws.
      server.setNotFoundHandler(async (request, reply) => {
        const path = request.url.split("?")[0] ?? "/";
        if (request.method !== "GET" || path.startsWith("/v1/")) return reply.status(404).send({ error: "not_found", message: "No such route." });
        const file = staticFile(path, dist);
        // A page the browser router draws gets the dashboard. A missing file, such as a favicon.ico nobody shipped, is
        // "not found", so a crawler or a browser doesn't get a web page where it asked for an image.
        if (!file && extname(path)) return reply.status(404).type("text/plain; charset=utf-8").send("Not found");
        if (!file) return reply.type("text/html; charset=utf-8").send(indexHtml);
        if (path.startsWith("/assets/")) reply.header("cache-control", "public, max-age=31536000, immutable");
        return reply.type(TYPES[extname(file)] ?? "application/octet-stream").send(readFileSync(file));
      });
    },
  });
  tenancy.setInject((request) => app.inject(request));
  return { app, tenancy };
}

/** Sign-in and testnet agents, when the server has a testnet wallet to pay from. Without one, it's sandboxes only. */
export function hostedOwners(env: NodeJS.ProcessEnv, dataRoot: string, webUrl: string): HostedOwners | undefined {
  const outlayerKey = env.OUTLAYER_API_KEY;
  if (!outlayerKey) return undefined;
  // One Wardy key signs every owner's verdicts. Kept with the data if it isn't set, so a restart keeps it.
  let signingKey = env.WARDY_HOSTED_SIGNING_KEY;
  if (!signingKey) {
    const file = join(dataRoot, "signing-key");
    mkdirSync(dataRoot, { recursive: true });
    if (!existsSync(file)) writeFileSync(file, generateSigningKey(), { mode: 0o600 });
    signingKey = readFileSync(file, "utf8").trim();
  }
  const aiKey = env.NEAR_AI_CLOUD_API_KEY;
  const analyzer = aiKey
    ? new DailyCappedAnalyzer(new NearAiContextAnalyzer({ apiKey: aiKey, model: env.NEAR_AI_MODEL || "z-ai/glm-5.3-flash" }), Number(env.WARDY_AI_DAILY_LIMIT || 500))
    : undefined;
  return {
    signIn: new WalletSignIn({ recipient: new URL(webUrl).host }),
    custody: new PoolDailyCap(new OutLayerCustody({ apiUrl: env.OUTLAYER_API_URL || "https://testnet-api.outlayer.ai", apiKey: outlayerKey }), env.WARDY_POOL_DAILY_LIMIT || "1"),
    env: { WARDY_SIGNING_KEY: signingKey, ...(env.NEAR_TESTNET_RPC_URL ? { NEAR_TESTNET_RPC_URL: env.NEAR_TESTNET_RPC_URL } : {}) },
    ...(analyzer ? { analyzer } : {}),
    maxOwners: Number(env.WARDY_MAX_OWNERS || 500),
    aiPerOwnerPerDay: Number(env.WARDY_AI_OWNER_DAILY_LIMIT || 50),
    publicChainData: new DemoOrChainData(new MockChainData(OFFLINE_ACCOUNTS), new Set(Object.keys(OFFLINE_ACCOUNTS)), {
      testnet: new NearChainData({ rpcUrl: env.NEAR_TESTNET_RPC_URL || "https://test.rpc.fastnear.com" }),
      mainnet: new NearChainData({ rpcUrl: env.NEAR_RPC_URL || "https://free.rpc.fastnear.com" }),
    }),
    requestsPerOwnerPerDay: Number(env.WARDY_OWNER_DAILY_REQUESTS || 1000),
  };
}

async function main() {
  assertNoMainnetKeys(process.env);
  if (!existsSync(join(DIST, "index.html"))) throw new Error("The dashboard isn't built. Run: npm run build:web");
  const port = Number(process.env.PORT || 8080);
  const webUrl = (process.env.WARDY_PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, "");
  const dataRoot = process.env.WARDY_DATA_DIR || join(".data", "hosted");
  const owners = hostedOwners(process.env, dataRoot, webUrl);
  const { app, tenancy } = await buildHostedApp({
    dataRoot,
    webUrl,
    indexHtml: readFileSync(join(DIST, "index.html"), "utf8"),
    proxyHops: Number(process.env.WARDY_PROXY_HOPS || 1),
    ...(owners ? { owners } : {}),
  });

  const sweep = setInterval(() => tenancy.sweep(), 10 * 60_000);
  // Hires from the Agent Market are answered by the public tenant: a signed check, looked up on NEAR, never a payment.
  const stopMarket = process.env.AGENT_MARKET_TOKEN
    ? startMarketLoop({ token: process.env.AGENT_MARKET_TOKEN, service: tenancy.publicWiring.service, earnings: tenancy.publicWiring.earningsLog, publicUrl: webUrl, isDemoPayee: (payee) => Object.hasOwn(OFFLINE_ACCOUNTS, payee), everySeconds: Number(process.env.WARDY_MARKET_POLL_SECONDS || 60) })
    : () => undefined;
  const stop = async () => {
    stopMarket();
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
