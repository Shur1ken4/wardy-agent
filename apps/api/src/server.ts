// `npm run dev`: starts the API. Offline by default, so it works with no setup.
import { existsSync } from "node:fs";
import { buildApp } from "./app.js";
import { wire } from "./wiring.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const host = process.env.WARDY_API_HOST || "127.0.0.1";
const port = Number(process.env.WARDY_API_PORT || 8787);

try {
  const wiring = await wire(process.env);
  const { mode, service } = wiring;
  const app = await buildApp({
    service,
    network: wiring.network,
    agentToken: wiring.agentToken,
    ownerToken: wiring.ownerToken,
    mode,
    logger: {
      level: "warn",
      // The route, not the URL: nothing a caller put in a URL ends up in a log.
      serializers: { req: (request: { method: string; routeOptions?: { url?: string } }) => ({ method: request.method, route: request.routeOptions?.url }) },
    },
  });

  service.on("hold", ({ verdict, approvalUrl, expiresAt }) => {
    console.log(`\nHOLD ${verdict.amount} to ${verdict.payee}: ${verdict.reasons[0]}`);
    // A link carrying a token doesn't belong in a live server's output.
    if (mode === "live") console.log(`Waiting for the owner. Verdict ${verdict.verdictId}, expires ${expiresAt}.`);
    else console.log(`Owner, decide here: ${approvalUrl}`);
  });

  const expiry = setInterval(() => service.expireHolds(), 60_000);
  const stop = async () => {
    clearInterval(expiry);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await app.listen({ host, port });
  console.log(`Wardy Agent API: http://${host}:${port} (${mode}, custody: ${service.providerName})`);
  if (mode === "offline") {
    console.log("Demo data. No keys, no funds, no network. Credentials are the public offline ones.");
    console.log(`Agent: ${wiring.agentToken}   Owner: ${wiring.ownerToken}`);
  } else if (mode === "testnet") {
    console.log(`Free test tokens only. Credentials are in ${wiring.dataDir}/secrets.json.`);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
