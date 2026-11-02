# Connect an agent to Wardy Agent

MCP is how an AI agent gets tools. This gives an agent four of them, and no way to spend on its own:

| Tool | What it does |
|---|---|
| `wardy_pay` | Asks to pay. Wardy Agent checks it, then pays, asks you, or refuses |
| `wardy_check` | Checks a payment without making it |
| `wardy_status` | Says what happened to a payment, such as what you decided after a HOLD |
| `wardy_network_lookup` | Looks up a payee in the Wardy Network |

The agent holds no keys and no spend grant. It can't approve its own payments or unfreeze anything. The MCP server
never reads your `.env`, so it can't reach your keys even if the agent is hijacked.

## Set it up

1. In one terminal, start the API and leave it running:

   ```bash
   npm run dev
   ```

   You should see `Wardy Agent is running (offline, custody: mock).`

2. In another terminal, print the setup for this computer:

   ```bash
   npm run mcp:config
   ```

3. Follow what it prints. For Claude Code, that's one command to copy and run. For Claude Desktop, it's a block to add
   to `claude_desktop_config.json`; restart Claude Desktop afterwards.

4. Ask your agent: *"Use wardy_pay to pay 2 wNEAR to acme-sh0p.near for invoice 77."*

   You should see it answer `BLOCK`, because that name imitates a payee the demo owner has paid, and say nothing was
   paid. Offline, this all runs on a mock ledger.

5. Ask it: *"Use wardy_pay to pay 1 wNEAR to northbridge-treasury.near."*

   You should see `HOLD`, and the dashboard shows it under **Waiting for you**. Press **Review**, then **Reject**. Then ask
   your agent: *"What happened to that payment?"* It should use `wardy_status`, and say it wasn't paid.

If you're writing your own agent instead, an answer carries a `nextStep` to act on, so it doesn't have to parse the words.
`GET /llms.txt` on the API explains it all in plain text.

## Testnet and live

The printed setup uses the public offline credential. For testnet or live, replace `WARDY_AGENT_TOKEN` and
`WARDY_OWNER_ID` with your own. Testnet's are in `.data/testnet/secrets.json`; live's are in `.env`. Use only the
**agent** token here. Never give an agent the owner token.
