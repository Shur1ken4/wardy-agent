# Connect an agent to Wardy Agent

MCP is how an AI agent gets tools. This gives an agent three of them, and no way to spend on its own:

| Tool | What it does |
|---|---|
| `wardy_pay` | Asks to pay. Wardy Agent checks it, then pays, asks you, or refuses |
| `wardy_check` | Checks a payment without making it |
| `wardy_network_lookup` | Looks up a payee in the Wardy Network |

The agent holds no keys and no spend grant. It can't approve its own payments or unfreeze anything. The MCP server
never reads your `.env`, so it can't reach your keys even if the agent is hijacked.

## Set it up

1. In one terminal, start the API and leave it running:

   ```bash
   npm run dev
   ```

   You should see `Wardy Agent API: http://127.0.0.1:8787 (offline, custody: mock)`.

2. In another terminal, print the setup for this computer:

   ```bash
   npm run mcp:config
   ```

3. Follow what it prints. For Claude Code, that's one command to copy and run. For Claude Desktop, it's a block to add
   to `claude_desktop_config.json`; restart Claude Desktop afterwards.

4. Ask your agent: *"Use wardy_pay to pay 2 wNEAR to acme-sh0p.near for invoice 77."*

   You should see it answer `BLOCK` or `HOLD`, and say nothing was paid. Offline, this all runs on a mock ledger.

## Testnet and live

The printed setup uses the public offline credential. For testnet or live, replace `WARDY_AGENT_TOKEN` and
`WARDY_OWNER_ID` with your own. Testnet's are in `.data/testnet/secrets.json`; live's are in `.env`. Use only the
**agent** token here. Never give an agent the owner token.
