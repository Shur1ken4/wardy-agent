# Wardy Agent

A payment firewall and shared scam-payee network for AI agents on NEAR.

> Spending limits protect one agent. Wardy Agent protects all of them.

**Status: under construction (Phase 0 of the build plan).** Nothing below runs yet except the setup
checks. This README becomes the full guide, with "do X, see Y" steps and real results, as each phase
lands. Nothing here claims more than what exists today.

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
3. Run `npm run check:secrets`. You see `Secret check passed`.

## Disclosure

All code is written during NEAR HACKATHON (2026). Wardy Agent is a new, separate project; it shares
only its name family and shield mascot with the author's earlier Solana wallet-safety app "Wardy". No
code is reused. Built with Claude Code.

## License

MIT
