# Wardy Agent

A payment firewall and shared scam-payee network for AI agents on NEAR.

> Spending limits protect one agent. Wardy Agent protects all of them.

**Status: under construction.** The decision engine, API, MCP server and testnet custody work. The dashboard,
the demo agent, the Attack Lab and the shared registry don't exist yet. This README becomes the full guide as they
land, and claims nothing beyond what runs today.

## What it will do

AI agents increasingly pay other agents, APIs and merchants by themselves. Spending limits stop big
losses, but agents still get tricked into paying lookalike payees, paying twice after a fake "payment
failed, please retry", or paying a swapped address from an invoice. Wardy Agent holds the only spend
permission for a fleet of worker agents, checks every payment, and answers ALLOW, HOLD (ask the owner)
or BLOCK, with reasons and evidence.

## Try what exists today

Requires Node 22.22 or newer (24 recommended).

1. Run `npm install`. You see it finish without errors.
2. Run `npm test`. You see every test pass.
3. Run `npm run walkthrough`. You see one payment of each kind go through the real API on a mock ledger: a hold, an
   owner approval, an allow, a block, a fake "payment failed", a freeze. It ends with `Everything was as expected.`
4. Run `npm run dev`, then, in another terminal, `curl http://127.0.0.1:8787/health`. You see `"status":"ok"`.
5. To connect an AI agent, follow [docs/MCP_SETUP.md](docs/MCP_SETUP.md).

## Disclosure

All code is written during NEAR HACKATHON (2026). Wardy Agent is a new, separate project; it shares
only its name family and shield mascot with the author's earlier Solana wallet-safety app "Wardy". No
code is reused. Built with Claude Code.

## License

MIT
