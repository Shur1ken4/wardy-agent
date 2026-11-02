// The MCP server, over stdio. It deliberately reads only these few settings and never loads `.env`: a worker agent
// runs this, and a worker agent must never be able to reach provider keys or the grant token.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./tools.js";

const server = createMcpServer({
  apiUrl: process.env.WARDY_API_URL || "http://127.0.0.1:8787",
  agentToken: process.env.WARDY_AGENT_TOKEN || "offline-agent-token",
  ownerId: process.env.WARDY_OWNER_ID || "demo-owner.near",
  workerName: process.env.WARDY_WORKER_NAME || "mcp-agent",
});

await server.connect(new StdioServerTransport());
