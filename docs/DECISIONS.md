# Decisions and verified facts

Everything here was checked on **2026-11-02**. Labels:

- **LIVE**: I called the service and saw the answer.
- **DOCS**: read in the official docs or SDK examples, not yet exercised.
- **TODO-VERIFY**: needs a key or funds. Phase 1 settles it.

If this file and the master brief disagree, this file wins, because the brief says the docs win.

## 1. What changed compared with the brief

| # | The brief says | What I found | What we do |
|---|---|---|---|
| 1 | No hackathon entry does the shared registry | **The official Security track starter prompt asks for exactly this**: a counterparty check, allow/warn/block, and "a shared blocklist that other agents can report to, with evidence attached". Leash has already shipped a version. | Stop claiming the registry is unique. Lead with what a blocklist can't do (section 2). |
| 2 | Demo uses `shop.near` and `sh0p.near` | **Both are real mainnet accounts** (created 2020 and 2022, LIVE). A signed report anchored on NEAR saying `sh0p.near` is a scam would be a false public accusation against a stranger. | **Approved by Shurik, 2026-11-02:** fixtures use `acme-shop.near`, `acme-sh0p.near`, `acme-shop-near.near`: all unregistered today (LIVE). Live and anchored data use accounts we control. Fixture reports are flagged as seed data and never count in live decisions. |
| 3 | Every BLOCK publishes a report; one valid report BLOCKs everywhere; disputes are stretch | A signed verdict proves Wardy Agent's *opinion*, not that a payee is a scammer. One lookalike false positive would spread to every agent, permanently. | **Approved by Shurik, 2026-11-02:** publish only when two independent detector families agree (for example D1 + D4, or D1 + D2) or the owner confirms. Single-family blocks stay local. The reporter can revoke its own report. Every attack scenario should still produce a report; the Attack Lab assertions check this. |
| 4 | Node 20+ | Vitest 5 needs Node 22.12+, near-api-js 22.22+, the Agent Connect SDK 24+. Node 20 reached end of life in April 2026. | `engines` >= 22.22, `.nvmrc` 24, CI on 22 and 24. TODO-VERIFY the SDK on Node 22; if it fails, load it only in live mode. |
| 5 | SQLite via `better-sqlite3` is fine | It's a native build that needs Node 22+. That's a needless clean-clone risk for judges. | JSONL ledger with an in-memory index, behind a small interface. No native dependencies. |
| 6 | "Two locks": provider limits plus Wardy Agent's checks | Provider `destinations` in `only` mode needs an owner signature per new payee, has a 10-minute cooldown and a 256-entry cap. That can't serve agents that choose their own payees. | Provider `destinations` is `any`. The README states it plainly: the provider locks limits, assets, budget and freeze; **Wardy Agent alone locks the payee**. That's the gap we fill, and it goes in "What's proven vs what's trusted". |
| 7 | A freeze endpoint pauses all execution | Provider freeze needs the owner's signature, which Wardy Agent doesn't hold. Unfreeze has a 10-minute cooldown (DOCS). | `/v1/freeze` stops Wardy Agent instantly; as the only spender, that stops all spending. A separate owner script does the provider freeze as the hard stop. |
| 8 | `Verdict.ai` has a yes/no `attested` field | Signatures come in two kinds: `provider_tee` (the model's TEE) and `gateway` (the gateway's TEE only). A matching signer doesn't prove the same serving instance (DOCS). | Add `signatureKind` and `attestationLevel` to `Verdict.ai`. Show the ✓ only for a full check. The UI says exactly what was proven. |
| 9 | Links in section 2 and 7 | OutLayer moved: `outlayer.fastnear.com` now redirects (HTTP 301), docs are at `app.outlayer.ai/docs`, API at `api.outlayer.ai`. Skill docs still name retired models such as `deepseek-ai/DeepSeek-V3.1`. | Use the URLs in section 3. Read model IDs from the live list. |
| 10 | Agent Market, "per check" | Pricing is per hire, 5% fee, in USD or USDC on a platform balance, not on-chain. No minimum price stated (DOCS). Clearance lists the same kind of job at $1. | The Earnings screen shows the real hire price and currency. The one paid hire needs real money from Shurik. |
| 11 | x402 staging is acceptable | PingPay's page documents production only (DOCS). | X1 is likely cut. |
| 12 | One submission per team | Official rule: one per **project**, at most two projects per person, and each README names the other (Q-015). | Tell me if there's a second project. |
| 13 | README section list | Also required: list libraries and AI-written code (Q-005). A local-only demo needs a **video**, because screenshots aren't enough (Q-012). A hosted demo is a plus; keep it up to Nov 18, ideally Nov 25. | Add a libraries section. Decide on a hosted read-only dashboard in Phase 8. |
| 14 | Claude Code runs the real ALLOW payment | My safety rules forbid me from moving real funds, even when asked. | **I write the script, Shurik runs the one command** for anything touching real mainnet money. Testnet I can run myself. Everything else is unchanged. |
| 15 | Start Nov 3 | Started Nov 2. | One day of buffer. |
| 16 | Verify attestation in Node, as other repos do | NEAR AI's own TypeScript verifier uses `@phala/dcap-qvl-node`, which has **critical advisory [GHSA-796p-j2gh-9m2q](https://github.com/advisories/GHSA-796p-j2gh-9m2q) with no fix**: it skips the QE Identity check, so a forged quote can pass. | We use `@phala/dcap-qvl` 0.7.0 (pure JS, same project, outside the affected range). A test feeds it forged QE Identity data and requires a rejection. Its `elliptic` dependency has a low-severity advisory about *signing*; we only verify, so it stays, noted here. |

Smaller notes to apply later:

- **Phase 2, D1:** edit distance of 2 at name length 4 flags `soap.near` against `shop.near`. Test whether the allowed distance should grow with length, and add near-miss cases.
- **Phase 2, D4:** Clearance found AgentKit's injection filter fired in 0 of 80 runs, because real attacks say "our account moved", not "ignore previous instructions". Our regex list must target plain business language.
- **Phase 4, overfitting:** tuning detectors on A1-A9 and then reporting A1-A9 proves little. I'll propose a small holdout set written after the rules freeze. Mumtaz and Gershuni will look for this.
- **Phase 7, Privacy track:** NEAR AI Cloud supports end-to-end encrypted chat to the attested model key, so even the gateway can't read the invoice. A strong candidate if time allows.
- **Agent Connect proof:** every execution has an attested transparency-log proof (`GET /v1/agents/{id}/operations/{op}/proof`). Attach it to the verdict; it costs little and adds real evidence.

## 2. Uniqueness and the gap

**The gap is still open.** `NEAR-Intents-Agent-API/examples#21` (one-time destinations) is OPEN, created Oct 28, no maintainer reply (LIVE). OutLayer's matching `out-layer/outlayer#34` is also OPEN, with only the reporter's follow-up. The policy schema has no `max_uses` or one-time destination (LIVE in `/llms.txt`, SDK 0.7.3). Agent Connect idempotency doesn't help: a tricked agent's retry is a new request under a new key. D3 stays. Clearance says it passed its runs to the Agent Connect team, so this could still ship; re-check before submitting.

**New evidence that helps us** (Clearance, reported by its author, not reproduced by us):

- Claude Opus 5.5 and GPT-6 Sol still paid twice in most runs with three of six public agent prompts.
- Adding "never pay the same invoice twice" didn't fix it, because the model believes the first payment failed.
- Clearance's own one-time permits don't fit "agents that choose the payee themselves". That's our user.

**Nearby projects found** (GitHub name and description search; nearbuilders.org/projects showed no entries, so this scan is **partial** and more will appear before Nov 14):

| Project | What it is | How Wardy Agent differs |
|---|---|---|
| [Leash](https://github.com/halfabillion/near-leash) | **Closest.** Testnet vault with a function-call key, caps, and a shared registry | Its registry blocks on one trusted report or **3 distinct reporters**, a count that cheap accounts can game, with free-text evidence. Its README and registry code show no lookalike, duplicate or invoice-reading detection |
| [Clearance](https://github.com/Selliksss/clearance) | Crash test before deployment, level certificates, Agent Market listing at $1 | Complement: it measures before launch, we enforce at runtime. Credit it |
| [Countersign](https://github.com/team-attention/countersign) | Earning agent with an allowlist wallet contract | Allowlist model: unknown payees wait for a human. No detection |
| [AgentSentinel](https://github.com/Daveboycyber/agent-sentinel) | Guardian contract and watcher | Last pushed Oct 21, README only. Watches rather than holding the only key |
| [SHREESHANTH99/agent-payment-firewall](https://github.com/SHREESHANTH99/agent-payment-firewall), [Ashin-06/agent-payment-firewall](https://github.com/Ashin-06/agent-payment-firewall) | Payment firewalls on PayPal sandbox and banking assistants | Not on NEAR, no shared network |
| [judge-near](https://github.com/vijaygopalbalasa/judge-near) | Judge-gated escrow | Different problem |

**Recommended differentiation.** Not near-identical to anything found, so I recommend building on. Lead with these, in this order:

1. **It stops what a blocklist can't see:** the first-ever lookalike and the second payment to the *right* merchant, the exact leak limits and allowlists leave open.
2. **Enforced on real custody:** the only grant on Agent Connect (mainnet), not an advisory check on testnet.
3. **Evidence instead of votes:** signed verdict plus Merkle proof anchored on NEAR, no counting. Resists the manufactured consensus that a threshold invites.
4. **Reads privately, provably:** verified TEE attestation for reading a payment's invoice at runtime. Clearance signs its test transcripts with TEE signatures and judge-near runs a judge on TEE workers, but neither reads a live payment's documents privately.
5. **Measured:** with/without losses *and* the honest-payment pass rate.

## 3. Integrations

### Agent Connect (NEAR Intents Agent API): primary custody, Must

- **Docs:** https://docs.agentsonintents.com/integration/agent-api/overview, guide https://api.agentsonintents.com/llms.txt, schema `/openapi.json`, examples https://github.com/NEAR-Intents-Agent-API/examples
- **SDK:** `@near-intents-agent-api/sdk` 0.7.3 (needs Node 24+, pure JS dependencies).
- **Network:** mainnet only, real funds. Production `https://api.agentsonintents.com`, demo `https://api.demo.agentsonintents.com`. Both report `network: mainnet`, `contract_id: outlayer.near`, status operational (LIVE). So Agent Connect runs on OutLayer custody.
- **Auth:** `X-API-Key: naa_…` identifies our backend (portal https://partners.near-intents.org/, shown once, doesn't expire). `X-Grant-Token: ngt_…` authorises spending.
- **Calls we'll use:**
  - Owner flow: `POST /v1/generate-intent` → sign → `POST /v1/submit-intent` → `GET /v1/status?correlation_id=…&wait_ms=30000`. Types: `agent_create`, `policy_update`, `grant_issue`, `grant_revoke`, `agent_freeze`, `agent_unfreeze`.
  - Payment: `POST /v1/agents/{id}/transfer` `{asset, amount, recipient}` with `Idempotency-Key` (we use `requestId`). Answers 202 with `correlation_id`.
  - Funding: `POST /v1/agents/{id}/deposit`. Reads: `GET /v1/whoami`, `/v1/tokens`, `/v1/network`, `/v1/agents/{id}/policy`, `/balances`.
- **Asset ids (LIVE):** `nep141:wrap.near` (wNEAR, 24 decimals), `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (USDC on NEAR, 6 decimals).
- **Native NEAR gotcha: confirmed in the docs and wider than reported.** "None of `destinations`, `budget`, `timelock_ms`, `schedule` or `owner_approval` applies to native requests: the switch is the whole fence." Our policy **omits the `native` block**, which means all off. Phase 1 proves the refusal.
- **Gotchas:**
  - Amounts are atomic integer strings.
  - Grants carry no permissions; the policy decides. Up to 50 grants per agent; we issue one.
  - A new policy applies only when `/policy` shows `APPLIED` and `provider_policy_synced: true`.
  - On `UNCERTAIN`, never resubmit under a new key: poll the same `correlation_id`. `NEEDS_REVIEW` stops automation.
  - A named recipient must exist on NEAR; implicit (64-hex) ids don't need to.
  - `transfer` credits the payee's **NEAR Intents balance**, not their wallet. `withdraw` to chain `near` delivers native NEAR. Must-level payments use `transfer`.
  - Policy edits have a 10-minute cooldown. Plan demos around it.
- **Funding (DOCS):** `POST /deposit` with `origin_asset: nep141:wrap.near` expects a **wNEAR token transfer** to the deposit address, not a plain NEAR send. That's awkward from a wallet, so `hello:custody fund` does it from the owner account in one transaction: register the address on `wrap.near`, wrap the NEAR, transfer.
- **Licensing:** the examples repo has **no license**, so nothing is copied from it. `scripts/hello-custody.ts` is our own code on the MIT-licensed SDK.
- **TODO-VERIFY (`npm run hello:custody`, run by Shurik):** whether a settled transfer exposes a NEAR tx hash for the "tx link" (the schema mentions `transaction_hash`; otherwise link the `op_…` proof). Whether a funded implicit owner account works for onboarding (the SDK's examples support it). The deposit minimum and any fee, which aren't in the docs. Which portal gives Shurik a key. That the native refusal returns `native_method_denied`.

### OutLayer: fallback custody, and a real testnet path

- **Docs:** https://app.outlayer.ai/docs/agent-custody. **API:** `https://api.outlayer.ai`, testnet `https://testnet-api.outlayer.ai` (health check 200, LIVE).
- **Auth:** `POST /register` returns a `wk_…` key once. Then `Authorization: Bearer wk_…`.
- **Calls:** `POST /wallet/v1/transfer` `{to, amount}` (yocto), `POST /wallet/v1/intents/transfer`, `GET /wallet/v1/balance?chain=near`.
- **Gotchas:** Intents routes return 503 on testnet. Free tier is 100 custody operations per wallet per day. Cumulative limits are best-effort under concurrency. A 422 `onchain_tx_failed` must not be retried.
- **Decision:** Agent Connect is the live provider. Since it has no testnet, I propose a small OutLayer testnet adapter for `WARDY_MODE=testnet`, so I can run real ALLOW transactions end to end with no real money.

### NEAR AI Cloud: private context check, Must

- **Docs:** https://docs.near.ai/cloud/verification. Reference code: https://github.com/near-examples/nearai-cloud-verification-example (JavaScript), https://github.com/nearai/nearai-cloud-verifier.
- **Auth:** `Authorization: Bearer <key>` from https://cloud.near.ai. Credits: buy, or claim $10 by joining https://nearbuilders.org/join.
- **Calls:**
  - Chat: `POST https://cloud-api.near.ai/v1/chat/completions` (OpenAI-compatible, non-streaming, canonical model id).
  - Models: `GET /v1/model/list` is public and shows `attestationSupported`, `verifiable`, `providerType`, prices (LIVE, 64 models).
  - Attestation: `GET /v1/attestation/report?model=…&provider=near&signing_algo=ecdsa&nonce=<64 hex>` with `x-no-aliasing: true`. Free. Returns `model_attestations[]` with `intel_quote`, `nvidia_payload`, `signing_address`, `request_nonce`.
  - Signature: `GET /v1/signature/{chat_id}?model=…&signing_algo=ecdsa`. `text` is `<model>:<request sha256>:<response sha256>` for `provider_tee`, or `<request>:<response>` for `gateway`.
  - GPU check: `POST https://nras.attestation.nvidia.com/v3/attest/gpu`. Check the overall result, per-GPU fields, `eat_nonce` and `exp`.
  - CPU check: verify `intel_quote` with `dcap-qvl` or https://proof.t16z.com/, and confirm the signing address and nonce are bound in the quote's report data. Model reports don't return `report_data`, so it's parsed from the quote.
- **Model (LIVE list):** `z-ai/glm-5.3-flash`: `attestationSupported`, `providerType: vllm` (other TEE models route through `chutes` or `tinfoil`), supports structured output, $0.08 in / $0.50 out per million tokens, so a check of about 1,000 tokens in and 200 out costs roughly $0.0002. Fallback `Qwen/Qwen3.8-27B`, also `vllm`.
- **Gotchas:**
  - The external models (Claude, GPT, Gemini) report `attestationSupported: false`. Never use them for context text.
  - Streaming and alias resolution produce gateway-kind signatures, so avoid both.
  - A signature lookup can transiently return 404 or `Chat id not found`: bounded retry, then `attested: false`, visibly.
  - A 2xx with `error_code` is not a signature.
- **TDX in Node:** `@phala/dcap-qvl` 0.7.0, collateral from Intel's PCS. `report_data` is the signing address right-padded to 32 bytes, then the raw 32-byte nonce (read from the official verifier). Tested on a real Intel quote: it verifies; tampered and forged-identity variants are rejected (LIVE, offline test).
- **Code:** `packages/providers/src/ai/nearAiCloud.ts`. `attested` is true only if all eight checks pass.
- **NVIDIA tokens:** read from NVIDIA's own HTTPS answer. TLS authenticates them; the JWT signature isn't separately checked. State this in "What's proven".
- **TODO-VERIFY:** `provider=near` reports actually return for `glm-5.3-flash`, and the service accepts our exact request. `npm run hello:ai` settles both once the key is in `.env`. Never fake a result: anything less than all eight checks shows as `partial`.

### Chain data: new-account detector, Must

- **Code:** `packages/providers/src/chain/nearChainData.ts`; try it with `npm run hello:indexer`.
- **NearBlocks:** `GET https://api.nearblocks.io/v1/account/{id}` gives `created.block_timestamp` in nanoseconds, plus `deleted` (LIVE). `/v1/account/{id}/txns/count` gives the count (LIVE). Mainnet data is current: 3 blocks behind the chain head (LIVE).
- **NearBlocks testnet is stale (LIVE):** `https://api-testnet.nearblocks.io` doesn't list our account or transactions, and its stub reports block 270.4M against a chain head of 275.9M, roughly 40 days behind. So `testnet` mode gets existence from RPC but no account age, and the detector reports that age is unavailable.
- **Explorer links:** use **NEAR Rocks** (FastNEAR): `https://testnet.near.rocks/tx/{hash}`, `https://testnet.near.rocks/account/{id}`, and `https://near.rocks/...` for mainnet. It shows our transactions and answers a plain HTTP request (LIVE). NearBlocks pages show a bot check, so an AI judge couldn't open them and I couldn't confirm what they show. NEAR Validate (`https://nearvalidate.org/txns/{hash}?network=testnet`) also works, as a backup.
- **Limits:** free tier about 6 calls a minute, 333 a day, attribution required (from NearBlocks' pricing pages, seen through search; the main page refused a direct fetch). Worked with no key today. So: cache in `.data/`, credit NearBlocks in the README and UI.
- **Gotcha (LIVE):** an unknown account answers **HTTP 200** with a stub and no `account_id`. Never read that as data.
- **RPC:** `view_account` on `https://free.rpc.fastnear.com` confirms existence and returns `UNKNOWN_ACCOUNT` when absent (LIVE). It gives no age. Fallback when the indexer is down, which yields `ACCOUNT_DATA_UNAVAILABLE`.
- **FastNEAR API:** tokens and pools only, no age (LIVE). Not used for D2.

### Registry contract: Must

- **Deployed (LIVE):** [`wardy-agent-registry.testnet`](https://testnet.near.rocks/account/wardy-agent-registry.testnet). Addresses and tx hashes: `config/registry.testnet.json`. The anchored roots so far are labelled dummies from `npm run hello:contract`. The on-chain code hash `7pUhLfAo…` equals the bs58 SHA-256 `cargo near build` printed. The account's history shows the two anchor attempts from a non-reporter, both refused on-chain.
- Rust as the brief prefers, from the `cargo near new` template: `near-sdk` 5.29.1, `cargo-near` 0.22.0, toolchain pinned to 1.93.0 by `rust-toolchain.toml`. 139 KB. 20 unit tests, clippy clean.
- **Stricter than the brief:** `anchor_root` refuses a shrinking `count`, and refuses a different root at the same `count`. A rewritten feed fails on-chain; a retry after a lost response is harmless.
- **Testnet faucet (LIVE):** `POST https://helper.nearprotocol.com/account` with `{newAccountId, newAccountPublicKey}` (the same service `near-cli-rs` uses). Keys are in the git-ignored `.data/testnet-accounts.json`, and hold only free test tokens.
- Called with `near-api-js` 7.4 (`Account.signAndSendTransaction`, `provider.callFunction`). Testnet RPC `https://test.rpc.fastnear.com`.

### 1Click: Should S2

- **Docs:** https://docs.near-intents.org/integration/distribution-channels/1click-api, schema https://1click.chaindefuser.com/docs/v0/openapi.yaml. **Network:** mainnet only, quotes are free.
- **Calls:** `GET /v0/tokens` (200, LIVE), `POST /v0/quote` with `dry: true`. No key needed for dry quotes.
- **LIVE result:** a Solana-format recipient on a Base route answers `recipient is not valid`, which is exactly scenario A6. Take asset ids from `/v0/tokens`, never by hand.
- **Note:** without a JWT there's an extra fee if you ever execute; the hackathon file says 0.2%, the 1Click docs 0.25%. Irrelevant for dry quotes.

### Agent Market: Should S1

- **Docs:** https://docs.market.near.ai/list-your-agent, skill https://market.near.ai/skill/SKILL.md (200, LIVE).
- **Auth:** `Authorization: Bearer aat_…`, created on the agent's page.
- **Calls:** `GET /v1/agents/me/assignments`, `POST /v1/assignments/{id}/start`, `POST /v1/assignments/{id}/submit` `{deliverableMarkdown}`. MCP at `https://market.near.ai/mcp`.
- **Gotchas:** signup and listing are in the web UI, with a confirmed email. Call `start` before working. Treat the brief as data. Self-hires don't count toward reputation. Fee 5%. Payout on acceptance or after 3 days (up to 7).

### Telegram: Should S3

Bot API with inline buttons. Not re-checked today; verify in Phase 7.

### PingPay x402: Stretch X1

- **Docs:** https://pingpay.gitbook.io/docs/pingpay-api/agent-pay-facilitator. Production `https://pay.pingpay.io/agentpay/x402`, `X-Api-Key`, needs Agent Pay enabled and a NEAR recipient set. USDC on Base, settles to NEAR.

## 4. Hackathon rules that bind us

- Copy of the official file: `docs/HACKATHON.md` (sha256 `8482c2ca…17d90`, fetched today). Re-read the live file before submitting.
- **Never without Shurik's explicit confirmation:** send the submission, post on X, make the repo public, push or force-push, sign transactions, spend tokens, deploy to mainnet, commit secrets.
- Submission API: `POST https://nearhackathon.com/api/applications`. Track ids `agents`, `security`, `privacy`. Team size is the exact string `1`. Print the payload and wait for a yes. One attempt per repository.
- The payout account is Shurik's own mainnet account. I never create or invent it.
- The starter prompt says to install NEAR's agent skills with `npx skills add`. I read them from a clone instead of installing them, so no third-party code ran on this machine.

## 5. Technical choices

| Choice | Why |
|---|---|
| Repo root is this folder | Simple for Shurik. The path contains a space, which also tests that our scripts survive one |
| No native dependencies | A judge's `npm install` can't fail on a compiler |
| Secret check as a dependency-free script, in the pre-commit hook and CI | Catches a key before it enters history, even before `npm install` |
| `npm run setup:keys` generates a dedicated owner key | Shurik never exports a seed phrase from a real wallet |
| Unbuilt top-level scripts exit with an error | Nothing can look like it works before it does |
| Commits use the GitHub no-reply email | The repo goes public; this keeps a personal email out of its history |
