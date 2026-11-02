# Architecture

How Wardy Agent is built, from the code as it is. For why things differ from the original plan, see [DECISIONS.md](DECISIONS.md).

## The idea in one paragraph

A worker agent has no keys and no spend grant. To pay anyone, it asks Wardy Agent, which holds the only grant. Every request goes through the same path: validate, detect, look up the Wardy Network, optionally read the attached text privately, decide by rules, sign, and only then pay. That order is why the check can't be skipped: there's no other way for the money to move.

## The parts

| Part | Folder | What it does |
|---|---|---|
| Core | [`packages/core`](../packages/core/src) | Detectors, decision rules, signing, audit log, ledger, the payment service, and the Wardy Network. Reads no network and holds no provider code |
| Providers | [`packages/providers`](../packages/providers/src) | Everything that talks to the outside: custody, chain data, private AI. Each has a real and a mock version |
| API | [`apps/api`](../apps/api/src) | The HTTP API, and `wiring.ts`, which picks real or mock from `WARDY_MODE` |
| MCP server | [`apps/mcp`](../apps/mcp/src) | `wardy_pay`, `wardy_status`, `wardy_check` and `wardy_network_lookup` for AI agents. It's a thin client of the API, and holds only the agent's credential |
| Dashboard | [`apps/web`](../apps/web/src) | The owner's console and the phone approval page |
| Demo agent | [`apps/demo-agent`](../apps/demo-agent/src) | A gullible worker agent and its scenarios |
| Attack Lab | [`apps/attack-lab`](../apps/attack-lab/src) | Runs scenarios with and without Wardy Agent, and writes the results |
| Registry contract | [`contracts/registry`](../contracts/registry/src/lib.rs) | Rust contract that stores the latest Merkle root. Only registered reporters can write, and the count can't shrink |

## What happens to a payment

```text
worker agent
   │  POST /v1/pay, with the agent's credential
   ▼
validate with zod ──▶ refuse a malformed request, and repeat nothing it sent back
   │
   ▼
detectors: lookalike, new account, duplicate, context tamper, cross-chain, policy
   │
   ▼
Wardy Network lookup: only valid reports from trusted keys count
   │
   ▼
private AI, if there's text and a key: findings can only add signals
   │
   ▼
decide(): five rules, in order, deterministic
   │
   ▼
sign the verdict, append it to the audit chain
   │
   ├── ALLOW ──▶ pay through custody ──▶ record the outcome
   ├── HOLD  ──▶ make a one-time link for the owner ──▶ wait, up to 30 minutes
   └── BLOCK ──▶ refuse ──▶ if the evidence is strong enough, publish a report
```

Each owner's payments run strictly one at a time. The duplicate check reads what has already settled, so two identical requests in parallel would otherwise both pass and both pay. A test sends them together, and exactly one is paid.

If custody can't confirm a payment, its status becomes `uncertain`. It counts as paid, and it's never retried automatically, because paying twice is the failure this project exists to stop.

## What an agent can rely on

Every answer has a `nextStep`, so an agent acts on a value instead of parsing English: `done`, `wait_for_owner`, `stop` or `tell_owner` for a payment, and `ok_to_pay`, `ask_owner_first` or `do_not_pay` for a check. After a HOLD, `wardy_status` (`GET /v1/pay/:id/status`) says what the owner decided, and nothing else about them. A bad request says what to fix. An agent given only the address can read `/llms.txt`, and one given only the repo can read [`AGENTS.md`](../AGENTS.md).

## Three modes

`WARDY_MODE` picks them, in [`wiring.ts`](../apps/api/src/wiring.ts).

| | `offline` (default) | `testnet` | `live` |
|---|---|---|---|
| Custody | Mock ledger | OutLayer testnet | Agent Connect, mainnet |
| Account data | Fixtures | NEAR RPC | NEAR RPC and NearBlocks |
| Private AI | Recorded answers, if any | NEAR AI Cloud, if there's a key | NEAR AI Cloud, if there's a key |
| Signing key | Public test key | Generated, git-ignored | From `.env`, required |
| Seed reports count | Yes | No | No |
| Demo tools | Yes | No | No |
| Costs | Nothing | Free test tokens | Real money, with a safety limit |

## What a verdict signs

A signature covers two layers, so that a public report can show one and hide the other, and still be verified:

- **Public:** verdict id, mode, request hash, payee, chain, decision, score, the codes that count against the payee, the imitated name, the attestation reference, signer and time.
- **Private, as a hash:** request id, asset, amount, full signals, reasons, and AI details. The random request id is what stops anyone guessing an amount against the hash.

`execution` and `networkReportId` change after the decision, so they aren't signed. The audit chain covers them.

## The Wardy Network

- **Feed:** append-only JSONL. Each line is one leaf: a report, or a revocation.
- **Tree:** RFC 6962, the Certificate Transparency form, tested against its published vectors. A proof needs the anchored count as well as the root, because hashes alone can't bind the count.
- **Anchor:** `npm run network:anchor` writes the root to the contract. The public record is [`config/network-anchor.testnet.json`](../config/network-anchor.testnet.json), and exactly what was anchored is [`config/network-feed.testnet.jsonl`](../config/network-feed.testnet.jsonl).
- **Lookup:** `GET /v1/network/payee/:chain/:payee` uses the same rules as a payment check, so it can't say "reported" about something a payment would ignore.

## Who can read what

| Data | Who |
|---|---|
| Wardy Network reports, proofs, anchor | Anyone |
| Whether a verdict's signature is valid | Anyone |
| `/health`: mode, provider, frozen | Anyone |
| Verdicts, stats, limits, live feed, audit log | The owner's credential |
| One held payment | Whoever holds its one-time link |
| Asking to pay, and the outcome of a payment | The agent's credential |
| Approving a payment, freezing, unfreezing | The owner only. The agent's credential can't do any of them |

## The dashboard

Vite and React, with no UI kit. Fonts ship with it, so it works with no internet. It talks only to its own origin, except when someone presses **Check the contract**, which reads a public RPC. The live feed uses `fetch` rather than `EventSource`, so the credential never goes in a URL. It closes when a tab is hidden or a page is left, because a browser allows six connections per site.

The hero's letter sphere is a 2D canvas: the geometry is in [`lib/sphere.ts`](../apps/web/src/lib/sphere.ts), and the drawing in [`LetterSphere.tsx`](../apps/web/src/components/LetterSphere.tsx). Each character is drawn once ahead of time, so over a thousand letters stay smooth. It stops when it's off screen or the tab is hidden, can be paused, and doesn't turn for anyone who asks for reduced motion.

`npm run dev` starts the API and dashboard together. The MCP server isn't started, because an AI client launches it for itself.

## How it's tested

| Check | What it covers |
|---|---|
| `npm test` | Unit and API tests, including attacks on signatures, reports and proofs |
| `npm run attack-lab -- --offline` | Every scenario. CI fails if the results differ from what's committed |
| Holdout set | Attacks written after the rules froze, published with their misses |
| `npm run network:verify -- --offline` | The anchored feed, the root and the API's proof |
| `npm run test:ui` | The real dashboard, used in Chrome at desktop and phone width, including accessibility |
| `cargo test` in `contracts/registry` | The contract |
| Planted bugs, one phase at a time | Whether the tests would notice. Each run has a control, and its misses were fixed or explained |
