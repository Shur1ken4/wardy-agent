# Wardy Agent

A payment firewall and shared scam-payee network for AI agents on NEAR.

> Spending limits protect one agent. Wardy Agent protects all of them.

**Status: under construction.** The decision engine, API, MCP server, testnet custody, demo agent and Attack Lab work.
The dashboard and on-chain anchoring of the shared registry don't exist yet. This README becomes the full guide as they
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
2. Run `npm run demo -- --offline`. You see every attack and honest payment, with and without Wardy Agent, ending in a
   line of totals. No keys, no funds.
3. Run `npm test`. You see every test pass.
4. Run `npm run attack-lab -- --offline`. It rewrites [the results](apps/attack-lab/results/latest.md), byte for byte the
   same as the committed file. See [Results](#attack-lab-results).
5. Run `npm run verify-audit -- apps/attack-lab/results/audit.jsonl`. You see `audit chain valid`, with every verdict's
   signature checked.
6. Run `npm run agent -- --scenario lookalike`. You see what the gullible agent read, what it asked, and the BLOCK.
7. Run `npm run walkthrough`. You see one payment of each kind go through the real API on a mock ledger: a hold, an
   owner approval, an allow, a block, a fake "payment failed", a freeze. It ends with `Everything was as expected.`
8. Run `npm run dev`, then, in another terminal, `curl http://127.0.0.1:8787/health`. You see `"status":"ok"`.
9. To connect an AI agent, follow [docs/MCP_SETUP.md](docs/MCP_SETUP.md).

## Attack Lab results

The same agent, with the same inbox, with and without Wardy Agent. [Full results](apps/attack-lab/results/latest.md).

- **Main set (9 attacks, 4 honest payments):** nothing lost with Wardy Agent, and no honest payment blocked. These were
  written alongside the rules, so they show the rules work as designed.
- **Holdout (8 attacks, 5 honest messages):** written after [the rules were frozen](apps/attack-lab/holdout/README.md).
  No honest payment was blocked, but **3 of the 8 attacks still took money**: each was a payee the owner really pays,
  under every limit, where only the words give the attack away. These results were run with the private AI off, and
  nothing was tuned after seeing them.
- **What "without" means:** a scripted agent that obeys everything, which is a worst case. It shows what's at stake, not
  how often a real model falls for it.

## Disclosure

All code is written during NEAR HACKATHON (2026). Wardy Agent is a new, separate project; it shares
only its name family and shield mascot with the author's earlier Solana wallet-safety app "Wardy". No
code is reused. Built with Claude Code.

## License

MIT
