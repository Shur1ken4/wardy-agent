# Wardy Agent: rules for every session

Master brief: `~/Downloads/WARDY_AGENT_CLAUDE_CODE_PROMPT.md`. Verified facts and every change from
that brief: `docs/DECISIONS.md`. If the two disagree, DECISIONS.md and the live docs win.

## Naming
The product is **Wardy Agent** (repo `wardy-agent`, packages `@wardy-agent/*`); its registry is the
**Wardy Network**. Shurik has an older, separate Solana app called "Wardy". No code, package, domain
or branding may say just "Wardy" in a way that could be confused with it.

## How we work
- Shurik is the founder and **not a developer**. You write all code, tests, docs and scripts. Explain
  every manual step in plain language: what to click, what to paste, what they should see.
- Stop at every **CHECKPOINT** (brief, section 20). Report: what works, what doesn't, and one command
  with its expected output.
- Don't invent endpoints, addresses, model names or SDK methods. Verify against live docs or mark
  `TODO-VERIFY`. Boring, reliable code over clever code. A judge must be able to clone and run it.
- Commit early and often. Never commit secrets. Don't push, create a remote or make the repo public
  without Shurik's explicit OK.

## Safety boundary (non-negotiable)
- **Real mainnet funds: you write the script, Shurik runs it.** You never execute a mainnet transfer,
  deposit, swap, withdrawal, purchase or deploy yourself. Testnet and the local mock ledger are fine.
- Shurik creates accounts on websites and pastes keys into `.env` themselves. Keys never go in chat.
- Only Shurik posts on X. Send the hackathon submission only after they confirm the exact payload.
- Mainnet total is at most 5 NEAR. Native NEAR transfers stay off in the custody policy.

## Hackathon facts
- NEAR HACKATHON. Submissions close **2026-11-14 23:59 UTC** (our target: 18:00). Judging Nov 16-18.
- $10K / $3K / $2K per track (13 tracks) + one $55K grand prize, paid in NEAR.
- Our track ids: `agents` (primary), `security`, `privacy`.
- Needs: public repo with LICENSE, public X post (says built at NEAR HACKATHON, tags @NEARProtocol and
  #NEARHackathon, with a **video**), and the form. One submission per project; it can't be edited.
- First-round judges are Claude Code and Codex: does it run, and does it do what the README says?
  README needs "do X, see Y" steps. A clean clone must work with one command, offline, no keys.
- Human judges: Polosukhin, Mumtaz, Lazzarin, Garg, Warwick, Qureshi, Gershuni.
- README must list libraries and AI-written code (Q-005) and name any second project (Q-015).
- All code is new. Re-read `https://nearhackathon.com/HACKATHON.md` before submitting.

## Product
- **Users:** the agent owner (funds a fleet, signs one policy, approves on phone); worker agents (no
  keys, no grant, must ask Wardy Agent to pay); other agents (pay per check, query the network).
- **Does:** checks every payment with five detectors + the Wardy Network, decides ALLOW / HOLD / BLOCK
  with a 0-100 score, reasons and evidence. Pays on ALLOW through custody. Asks the owner on HOLD.
  Refuses on BLOCK and publishes a signed report. Reads invoices privately in a TEE on NEAR AI Cloud
  with verified attestation. Earns through a paid check and an Agent Market listing. Proves itself in
  an Attack Lab that replays attacks with and without it.
- **Principles:**
  1. Wardy Agent is the only spender, so the worker cannot skip the check.
  2. One-way ratchet: rules decide; the AI can only add risk, never lower it or turn BLOCK into ALLOW.
  3. No evidence, no report. No votes, no counts, no reputation by popularity. A public report needs
     two independent detector families or owner confirmation, and the reporter can revoke it.
  4. Honest scope: the README has a "What's proven vs what's trusted" section.
  5. False blocks are failures: honest-payment pass rate is a headline metric.

## Scope
**Must** (submission fails without these):
- M1 decision engine: D1-D4, D5 format checks, policy checks, scoring, decision rules, unit tests
- M2 signed verdicts (ed25519), verify helper + endpoint
- M3 custody adapter: mock + one real provider (Agent Connect preferred, OutLayer fallback); only grant
- M4 HTTP API + MCP server with `wardy_pay` and `wardy_check`
- M5 gullible demo worker agent that pays only through Wardy Agent
- M6 Attack Lab: 8+ attacks + 4+ honest payments, with/without, table in Markdown + JSON
- M7 owner HOLD flow: phone-friendly approval page
- M8 Wardy Network v1: signed feed + query endpoint + Merkle root anchored on NEAR testnet
- M9 private context check on NEAR AI Cloud with attestation verified + recorded offline fixtures
- M10 dashboard: Live verdicts, detail, Policy, Attack Lab, Network, Earnings
- M11 README, `npm run demo` and `npm run demo -- --offline`, `.env.example`, CI (tests + offline demo)
- M12 hash-chained audit log with a verify command

**Should** (only after all Must items pass end to end): S1 Agent Market listing + one paid hire,
S2 1Click route check, S3 Telegram HOLD bot, S4 per-report contract storage.

**Stretch** (only after Nov 12): X1 x402 paid check, X2 payee disputes, X3 decision service in a TEE.

**Won't:** new token, NFT, DAO, ERC-8004 registry, general agent reputation, custom wallet or key
management beyond what the provider SDK needs, large mainnet amounts.

Feature freeze: end of Nov 12. Nov 13 is bug fixes only. Cut Should/Stretch, never Must or tests.

## Security requirements
- No secrets in git. `.env` is ignored and `.env.example` is complete. `npm run check:secrets` runs in
  the pre-commit hook and CI.
- Live mode refuses to start above 10 NEAR equivalent unless `WARDY_I_UNDERSTAND_RISK=1`.
- Invoices, emails and tool results are untrusted data: never in a system prompt as instructions, never
  `eval`'d, never rendered as HTML (escape everything).
- zod on every API input. Rate limit `/v1/check`.
- Owner approval links carry a random one-time token that expires in 30 minutes.
- Worker agents never see provider keys or grant tokens.
- Never log keys, tokens or raw context text in production mode.
- `docs/THREAT_MODEL.md` lists assets, attackers, attack paths, mitigations and what's out of scope.

## Never do
- Invent endpoints, model names, addresses or numbers. Verify or mark `TODO-VERIFY`.
- Hard-code results in the README or UI. Every number comes from a real run.
- Let the LLM make the final decision or lower a risk score. Fake an attestation.
- Send private context anywhere except NEAR AI Cloud, or store it in the Network (hashes only).
- Publish a report about a real third-party account from demo data. `shop.near` and `sh0p.near` are
  real accounts; fixtures use names checked to be unregistered (see DECISIONS.md).
- Use more than 5 NEAR on mainnet, or enable native NEAR transfers in the custody policy.
- Add features outside Must before all Must items pass.
- Copy code or scenario text from other hackathon projects. Credit ideas instead.
- Leave Shurik with an unexplained manual step.
