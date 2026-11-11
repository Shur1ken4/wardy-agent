// `npm run market:work`: answers Agent Market hires from this machine, with this instance's rules and key, and prints
// each one. Needs AGENT_MARKET_TOKEN in .env. Add `--once` to poll a single time, for a check.
import { existsSync } from "node:fs";
import { wire } from "@wardy-agent/api";
import { marketWorker, startMarketLoop } from "./market-loop.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const token = process.env.AGENT_MARKET_TOKEN;
if (!token) {
  console.error("AGENT_MARKET_TOKEN is empty. Make a token on market.near.ai (Your agents, Agent API tokens) and paste it into .env.");
  process.exit(1);
}
const wiring = await wire(process.env);
const publicUrl = process.env.WARDY_PUBLIC_URL || wiring.webUrl;
if (process.argv.includes("--once")) {
  const result = await marketWorker({ token, service: wiring.service, earnings: wiring.earningsLog, publicUrl, log: console.log }).poll();
  console.log(`Polled once: ${result.delivered} delivered, ${result.askedBack} asked back. Earned so far: ${JSON.stringify(wiring.earnings())}`);
} else {
  console.log(`Answering Agent Market hires every ${process.env.WARDY_MARKET_POLL_SECONDS || 60}s (${wiring.mode}). Press Ctrl+C to stop.`);
  startMarketLoop({ token, service: wiring.service, earnings: wiring.earningsLog, publicUrl, everySeconds: Number(process.env.WARDY_MARKET_POLL_SECONDS || 60) });
}
