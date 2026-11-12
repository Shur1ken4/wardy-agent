# Who else is doing this, and where Wardy Agent is different

Checked on 2026-11-03, from public docs, READMEs and vendor pages. Most of this is what vendors say about themselves, and
we haven't run their products. A blank means we didn't find the feature, not that it can't exist. New hackathon entries
will keep appearing until Nov 14.

## The short version

Almost everyone in this market answers **"how much may this agent spend?"** Wardy Agent answers **"who is being paid, and
why, and is this a mistake or a scam?"** Those are different questions, and a payment can pass the first and still be
stolen: a lookalike account, or the same invoice paid twice, can sit well inside every limit.

## The market, in five groups

| Group | Examples | What they do | What's left open |
|---|---|---|---|
| **Wallets with spending limits** | [Coinbase Agentic Wallets](https://www.crossmint.com/learn/agent-wallets-compared), [Crossmint](https://www.crossmint.com/solutions/agentic-payments), [Privy, Turnkey](https://www.openfort.io/blog/best-agent-wallets-for-developers), [Payman](https://agentspay.ai/blog/best-agent-payment-platforms) | Caps, allowlists, approvals, set per agent | A [crosswalk of 14 providers](https://github.com/Pink-Agentic-Payments/agent-spending-controls-crosswalk) describes caps and allowlists. An allowlist also stops the honest new supplier, and says nothing about the second payment to the right merchant |
| **Scam and transaction screening** | [Blockaid](https://blockaid.io/blog/prompt-injection-via-tokens-the-dark-side-of-agentic-commerce), [AnChain.AI](https://www.anchain.ai/blog/metamask), [ChainAware](https://chainaware.ai/blog/blockchain-data-providers-ai-agents-wallet-data-2026/) | Simulate a transaction, score tokens, and look up known-bad addresses | They're strong on drainers and bad tokens. They judge the transaction, not this owner's history or the invoice behind it. A brand-new lookalike has no bad record yet |
| **Agent identity** | [Skyfire](https://agentspay.ai/blog/best-agent-payment-platforms), [Visa and Mastercard's agent programs](https://appliedtechnologyindex.com/research/2026-comparative-analysis-agentic-commerce-payment-protocols/) | Prove which agent is asking | A real, verified agent can still be fooled by an invoice |
| **Payment protocols** | [x402, AP2](https://www.crossmint.com/learn/agentic-payments-protocols-compared) | Move the money, and record what was authorized | [x402 assumes the agent already has the authority to spend](https://ai-solutions.daviesmeyer.com/en/blog/agentic-commerce-checkout-acp-vs-ap2-vs-x402). Wardy Agent sits before any of them |
| **Hackathon-scale firewalls** | Solana: [solguard](https://github.com/mirahahmed3690/solguard), [SkillGuard](https://github.com/VincenzoImp/skillguard), [SolAgent Vault](https://github.com/HkSolDev/solagent-vault), [onchain-agent-wallets](https://github.com/nirholas/onchain-agent-wallets). Others: [OnlyFence](https://github.com/seallabs/onlyfence), [Sui Agent Payment Guard](https://awesome.ecosyste.ms/projects/github.com%2Fdavidweb3-ctrl%2Fsui-agent-payment-guard), [X402 Lookout](https://github.com/S1T1/X402LOOKOUT). NEAR: [Leash](https://github.com/halfabillion/near-leash), [Clearance](https://github.com/Selliksss/clearance), [Countersign](https://github.com/team-attention/countersign), [near-agent-payment-checker](https://github.com/fliptrigga13/near-agent-payment-checker) | Mostly rules: limits, allowlists, panic locks, approvals | See below. Closest idea to ours: [Pink](https://github.com/Pink-Agentic-Payments/agent-spending-controls-crosswalk) describes a duplicate-invoice signal, though the agent reports it about itself, in a sandbox |

## What only Wardy Agent combines

We didn't find another product with all five. Each is checkable in this repo.

| What | Why it matters | See it |
|---|---|---|
| **Catches the first-ever lookalike**, against who you've really paid | A blocklist can't know a scam account made today | Network and Attack Lab, A1 |
| **Catches the second payment to the right merchant**, even when told the first one failed | Limits and allowlists both let this through | Attack Lab, A2 |
| **Reads the invoice in a TEE, with verified attestation**, and the AI can only add risk | Others either don't read it, or read it in the open | README, "What's proven" |
| **Evidence, not votes**: signed reports, a Merkle root on NEAR, two kinds of evidence to publish, and a way to withdraw | A count can be gamed with cheap accounts, and [Leash](https://github.com/halfabillion/near-leash) uses one | `npm run network:verify` |
| **Publishes its own misses and its false blocks** | Nobody else we found prints a holdout's failures | `npm run demo -- --offline` |

**The one-liner:** *Spending limits decide how much. Wardy Agent checks who, and why.*

### Closed since this review

**An inflated amount from a known payee.** [Attackers inflate x402 prices](https://rohitraj.tech/notes/ai-agent-payments-x402-vs-ap2-2026), and our limits couldn't see it. The unusual amount check now asks the owner. It has real gaps, which the holdout publishes (C1 to C4, C6).

### Scanned again on 2026-11-11

New NEAR entries since the first scan, from their READMEs only (not run): [Halter](https://github.com/Arashrahmaniii/halter)
(policy wallet, shared scam registry, a counterparty "Scout", MCP tools), [NearGuard](https://github.com/georgeonweb3/near-guard)
(blocklist, allowlist, daily limit, freeze, allow/warn/block), [Sentinel](https://github.com/NathanOyewole/sentinel)
(counterparty score from account age, contract status, blocklist and an AI risk read, with an audit trail),
[Checkpoint](https://github.com/Phantomcall/Checkpoint__V2) (three locks: rules, the owner's on-chain approval of one
basket, and a vault), and several projects named Leash ([one](https://github.com/Mattbusel/leash),
[two](https://github.com/d0txyz/leash), [three](https://github.com/hycorange/near-leash)) built from the security
track's starter prompt. The pattern is the same across all of them: a policy wallet or vault, a blocklist, a
counterparty score, and an approval step. That's the starter prompt, done well by many hands, which is why the
registry and the allow/warn/block answer are not claimed as original here. None of them, by their READMEs, reads the
invoice behind a payment privately with the attestation verified, catches the second payment to the right merchant,
publishes a holdout of what it misses, or refuses to count reports.

### Scanned again on 2026-11-12

Newer NEAR entries, from their READMEs and live pages only (not run):

- [SIEGE](https://github.com/StarAtNyte/siege) is the closest to us. It reads the owner's instruction and what the
  agent read, refuses payments nobody asked for (injection, lookalikes), and holds funds in a two-key vault. Its
  strongest idea is an **evolutionary attacker** that searches for the worst loss against the guard's own code. Our
  Attack Lab replays fixed and holdout sets instead. A search like theirs is the honest next step for us, credited to them.
- [Probarion](https://github.com/probarion/probarion): owner-signed mandates enforced by a NEAR contract, with a signed,
  hash-chained ledger anchored on chain and NEAR AI Cloud as an adviser. Strong on "prove every payment". It checks
  the mandate, not who the payee really is.
- [Safe Near](https://github.com/poppingbean/entity-tracker): live hack tracing, contract audits and an "is it safe?"
  API, Telegram bot and MCP tools for all of NEAR. It looks at accounts and contracts, not at the owner's own payment
  history or the invoice.
- [Tapproved](https://github.com/manex-tech/tapproved): larger agent payments wait for a button on an ESP32 device.
- [Fixseal](https://github.com/MorikiKamio/fixseal): AI-written fixes to a spending policy are accepted only after a
  judge replays the exploit and checks a proof.
- Also: [AgentGuard](https://github.com/Night-Etrenal/agentguard-near) and
  [AgentFence](https://github.com/lisaaai200/agent-fence) (limits plus function-call keys), and about ten more projects
  called Leash.

What we still combine that we didn't find elsewhere: the owner's own payment history as the baseline for a lookalike,
the duplicate payment to the right merchant, a private invoice read with attestation verified, reports that need
evidence instead of votes, and a published list of misses. What they do better is in the table below.

## Where others are ahead

Being honest about these is part of the pitch.

| Gap | Who has it | What we could do |
|---|---|---|
| **A held payment doesn't reach your phone by itself.** The dashboard shows a pop-up and a one-tap page, and a browser notification if allowed, but nothing messages you | [SkillGuard](https://github.com/VincenzoImp/skillguard) has mobile approval | The Telegram bot, already on the list as S3 |
| **Setup needs a terminal** for your own instance. The hosted version at wardy-agent.fly.dev now has NEAR wallet sign-in and a real testnet agent per owner, so this is closed for trying it | Every commercial wallet | Done for the hosted server (2026-11-09) |
| **Connecting an agent on testnet or live is manual:** `npm run mcp:config` only prints the demo credential | Most SDKs | A `--testnet` option |
| **Other chains.** We enforce on NEAR. Competitors reach Solana, Base and more | Coinbase, Crossmint, Turnkey | Our check already spots an address from the wrong chain. Leave the rest: it's out of scope |
| **A searched worst case.** We replay fixed attack sets. Nobody searches for the sequence that loses the most | [SIEGE](https://github.com/StarAtNyte/siege) runs a genetic search against its guard | After the hackathon: the same kind of search against our rules, credited to them |
| **Token and contract scanning** | [Blockaid](https://blockaid.io/blog/prompt-injection-via-tokens-the-dark-side-of-agentic-commerce) | Don't chase it. We check payments, and it's their whole business |
