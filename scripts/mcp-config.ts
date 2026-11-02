// `npm run mcp:config`: prints exactly what to add to Claude Code or Claude Desktop, with this machine's paths.
// It prints the public offline credential only. For testnet or live, swap in WARDY_AGENT_TOKEN from .env yourself.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(root, "node_modules", ".bin", "tsx");
const server = join(root, "apps", "mcp", "src", "index.ts");
const env = {
  WARDY_API_URL: "http://127.0.0.1:8787",
  WARDY_AGENT_TOKEN: "offline-agent-token",
  WARDY_OWNER_ID: "demo-owner.near",
  WARDY_WORKER_NAME: "claude",
};

const flags = Object.entries(env).map(([name, value]) => `-e ${name}=${value}`).join(" ");
console.log("Claude Code: run this once.\n");
console.log(`claude mcp add wardy-agent ${flags} -- "${tsx}" "${server}"\n`);
console.log('Claude Desktop: add this to claude_desktop_config.json, inside "mcpServers".\n');
console.log(JSON.stringify({ "wardy-agent": { command: tsx, args: [server], env } }, null, 2));
