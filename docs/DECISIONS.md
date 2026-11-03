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
| 3 | Every BLOCK publishes a report; one valid report BLOCKs everywhere; disputes are stretch | A signed verdict proves Wardy Agent's *opinion*, not that a payee is a scammer. One lookalike false positive would spread to every agent, permanently. | **Approved by Shurik, 2026-11-02:** publish only when two independent detector families agree (for example D1 + D4, or D1 + D2) or the owner confirms. Single-family blocks stay local. The reporter can revoke its own report. **Corrected in Phase 4:** not every attack should produce a report. A1, A3, A5, A8 and A9 do. A4 doesn't, because the payee is a real merchant whose invoice was tampered with. A6 doesn't, because a wrong format may be an honest mistake. The Attack Lab checks each one. **Known limit:** an attacker can send an invoice naming an innocent brand-new or lookalike account, and it could be reported. A `check` can't publish, and revocation exists, but disputes are stretch work. The threat model must say this. |
| 4 | Node 20+ | Vitest 5 needs Node 22.12+, near-api-js 22.22+, the Agent Connect SDK 24+. Node 20 reached end of life in April 2026. | `engines` >= 22.22, `.nvmrc` 24, CI on 22 and 24. TODO-VERIFY the SDK on Node 22; if it fails, load it only in live mode. |
| 5 | SQLite via `better-sqlite3` is fine | It's a native build that needs Node 22+. That's a needless clean-clone risk for judges. | JSONL ledger with an in-memory index, behind a small interface. No native dependencies. |
| 6 | "Two locks": provider limits plus Wardy Agent's checks | Provider `destinations` in `only` mode needs an owner signature per new payee, has a 10-minute cooldown and a 256-entry cap. That can't serve agents that choose their own payees. | Provider `destinations` is `any`. The README states it plainly: the provider locks limits, assets, budget and freeze; **Wardy Agent alone locks the payee**. That's the gap we fill, and it goes in "What's proven vs what's trusted". |
| 7 | A freeze endpoint pauses all execution | Provider freeze needs the owner's signature, which Wardy Agent doesn't hold. Unfreeze has a 10-minute cooldown (DOCS). | `/v1/freeze` stops Wardy Agent instantly; as the only spender, that stops all spending. A separate owner script does the provider freeze as the hard stop. |
| 8 | `Verdict.ai` has a yes/no `attested` field | Signatures come in two kinds: `provider_tee` (the model's TEE) and `gateway` (the gateway's TEE only). A matching signer doesn't prove the same serving instance (DOCS). | Add `signatureKind` and `attestationLevel` to `Verdict.ai`. Show the ✓ only for a full check. The UI says exactly what was proven. |
| 9 | Links in section 2 and 7 | OutLayer moved: `outlayer.fastnear.com` now redirects (HTTP 301), docs are at `app.outlayer.ai/docs`, API at `api.outlayer.ai`. Skill docs still name retired models such as `deepseek-ai/DeepSeek-V3.1`. | Use the URLs in section 3. Read model IDs from the live list. |
| 10 | Agent Market, "per check" | Pricing is per hire, 5% fee, in USD or USDC on a platform balance, not on-chain. No minimum price stated (DOCS). Clearance lists the same kind of job at $1. | The Earnings screen shows the real hire price and currency. The one paid hire needs real money from Shurik. |
| 11 | x402 staging is acceptable | PingPay's page documents production only (DOCS). | X1 is likely cut. |
| 12 | One submission per team | Official rule: one per **project**, at most two projects per person, and each README names the other (Q-015). | **Shurik, 2026-11-02:** no second project so far, so the README names none. This can change: if one starts, each README has to name the other (Q-015). Check again before submitting. |
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

**Decision engine, Phase 2.** Each of these goes beyond or differs from the brief, for the reason given:

| Change | Why |
|---|---|
| A verdict also carries `requestHash`, `payee`, `chain`, `asset`, `amount` | In the brief's shape, an ALLOW signature names only a request id, so it wouldn't prove *which* payment was approved. Now it does |
| The signature leaves out `execution` and `networkReportId` | Both change after the decision, and a report quotes the signature, so signing them is circular. The audit chain covers them. The README must state this |
| `RETRY_PRESSURE` forces at least HOLD | Otherwise a retry after the 15-minute window, with a new invoice number, on a known payee scores 10 and gets paid. That's the exact double payment this product exists to stop |
| Edit distance: 1 for names of 4-5 characters, 2 for 6 or more | At 2 on short names, `bishop.near` and `soap.near` look like `shop.near` |
| A child account of a known payee isn't a lookalike | Only `shop.near` can create `pay.shop.near`, so it really is theirs |
| Invoice number matches per payee; invoice text matches across payees | Two merchants can both issue invoice 1001. The same document with a different payee is a swapped-address attack |
| Policy signals that force BLOCK score 50 | The brief gives no number. Reasons rank by points, so "this address can't exist on Base" outranks "over your limit" |
| New `CHAIN_NOT_CHECKED` (low, 10) | A chain we can't check should say so, not pass silently |
| Reusing a `requestId` for a different payment is refused | Returning the old verdict could read as approval of the new payment |
| Bypass patterns are deliberately narrow | A hit is a hard BLOCK, so "please disregard the previous invoice" must not match |

**API and execution, Phase 3.** Each of these goes beyond or differs from the brief:

| Change | Why |
|---|---|
| Payments run one at a time per owner | D3 reads what has settled, so two identical requests in parallel would otherwise both pass and both pay. A test sends ten at once: one pays |
| New `uncertain` status, counted as paid | A lost response doesn't mean no payment. Agent Connect says never to resend under a new key. A retry after `uncertain` is held, not paid |
| Two credentials: agent and owner | The brief defines none. Without them, anything reaching the API could spend, and a hijacked agent could unfreeze. Offline uses public ones; live refuses to start without its own |
| The approval token reaches only the owner | If `/v1/pay` returned the link, an agent could approve its own HOLD. It goes to the owner's channel; only its hash is stored |
| Hard limits are checked again on approval | The budget may be gone by the time the owner answers |
| A `check` is signed as a check, and has its own request-id space | Asking first must not stop the payment, count as a split-payment attempt, or read as permission to pay |
| Another owner's check uses no policy | Our limits and freeze are ours; they'd give other agents wrong answers |
| Live server output carries no approval token | "Never log tokens in production". Offline and testnet print the link for convenience |
| The signature covers an explicit list of fields | Found when the API added `agentId` for display and broke verification of its own answers |
| API binds to 127.0.0.1 by default | Anyone can read verdicts and ask for checks, which is fine locally and not on the open internet. A hosted demo needs a review first |

**Facts found by real testnet calls, 2026-11-02 (LIVE), because OutLayer's docs don't show them:**
- A transfer returns `{ request_id, status, tx_hash }`.
- `X-Idempotency-Key` works on `/wallet/v1/transfer`, though the docs mention it only for other routes. A replay answers HTTP 200 with `error: duplicate_idempotency_key` and the first result nested under `result`. The balance moved once.
- A transfer to a missing account answers 422 `onchain_tx_failed`, with a real `tx_hash` and no money moved. Too little balance answers 402 `wallet_underfunded`.

**Attack Lab and demo agent, Phase 4:**

| Choice | Why |
|---|---|
| Offline results say the AI "didn't run" until real answers are recorded | Made-up answers in a results table would be fake data. Every decision has to stand without the AI anyway. `npm run attack-lab -- --record` fills this in once a key exists |
| A replay of a recorded answer always says `attested: false` | No TEE ran for that answer, even if one did when it was recorded |
| Losses come from money that moved, against what was owed | A hard-coded column could lie. If the owner approves a held attack, the loss shows up |
| The scripted agent is labelled a worst case | It obeys everything, so "without" shows what's at stake, not how often a real model falls for it. `npm run attack-lab -- --llm` measures a real model once a key exists |
| A fixed clock and ids make runs byte-for-byte repeatable | CI runs the lab and fails if the committed results differ, so every published number is real |
| Results live in `apps/attack-lab/results/` | The brief says `attack-lab/results/`; the app sits under `apps/` in the brief's own layout |
| A report carries its signed verdict | A signature can't be checked without what it signed. It publishes the payee, amount and signal codes of a blocked payment. It holds no invoice text. It can hold an account id the AI read from a document, in `CONTEXT_PAYEE_MISMATCH` |
| Another owner's agent can only ask | Wardy Agent doesn't spend for it. If told ALLOW, it pays by its own means, and the lab counts that against Wardy Agent if the payee was bad |

**Still open:** record real AI answers, and measure a real model, once a NEAR AI Cloud key is in `.env`.
| 17 | `NetworkReport` holds hashes and codes, and "the verdict signature verifies" | Verifying a signature needs what was signed. My Phase 4 fix put the whole signed verdict in each public report, which published the **amount** and text like "a payee you paid 3 times". No invoice text, but it reveals who an owner does business with, permanently once anchored. | A verdict's signature now covers public facts plus `privateHash`, a hash of the rest (`requestId`, `asset`, `amount`, `signals`, `reasons`, `ai`). A report carries only the public part, and anyone can still verify the original signature. The random `requestId` is what stops someone guessing amounts against the hash. This changed every verdict signature, so `audit.jsonl` was regenerated. No decision changed: `latest.md` and `latest.json` are byte-identical, and the frozen rule files weren't touched. **What's still public:** the payee, the name it imitated, the score, the codes, the time, and the reporter's key. |
| 18 | Revocation unspecified | My Phase 4 revocation was an unsigned `revokedAt` outside the leaf, so a relay could add or strip one. | A revocation is signed by the report's own reporter, and is a leaf of its own in the feed, so an anchored root commits to it. A forged one is ignored, and the report keeps counting. **Limit:** someone handed one report and its proof can't tell if a later revocation exists. Only someone with the whole feed can, up to the last anchor. |
| 19 | `count` in `anchor_root` | An inclusion proof doesn't bind the count: trees of 13 and 14 leaves can give a leaf the same path. A test caught me claiming otherwise. | `verifyMerkleProof` takes the trusted root **and** count, and the contract stores both. |
| 20 | `GET /v1/network/payee` returns `reports` | Returning every line would say `reported: true` for forged or withdrawn reports. | The lookup applies the checker's own rules. `reported`, `reports` and `merkleProof` cover only reports that count. Added: `withdrawn`, so a falsely reported payee can point to it. `GET /v1/network/reports` shows everything, marked `counts` and `anchored`. Added: `npm run network:verify`, because a judge needs one command to check the anchor without keys. |
| 21 | `npm run network:seed` populates the registry | The Attack Lab is deterministic, so its reports can be rebuilt by anyone and compared with what was anchored. | The lab's reports are always labelled `seed`, on names `check:fixtures` covers. CI compares them to `results/network-seed.jsonl`. **The chain isn't clean of demo data:** the first two anchors are labelled dummy roots from Phase 1, and the contract can't forget them. `hello:contract` now refuses to replace a real root. **Seed dates:** they come from the lab's fixed clock (2026-11-14 12:00 UTC), so a report's `createdAt` can be later than its anchor. |
| 22 | Anchor "every N reports" | Only the anchor command exists, run by hand. The contract only keeps the latest root, and the feed only grows. | **Must re-run after recording AI answers:** recorded answers change the seed verdicts, so `network:verify` fails until `npm run network:anchor` adds the new seeds. Old seeds stay in the feed as history. A real run's report only goes up via `--feed`, and is refused unless it's about a testnet name that's unregistered or ours. |
| 23 | `GET /v1/verdicts`, `/v1/stats`, `/v1/policy` and `/v1/stream` have no credential | They show an owner's payment history, amounts and limits to anyone who can reach the API. It didn't matter while it only listened on this machine, but it would the moment it's hosted. | They need the owner's credential. `GET /v1/verdicts/:id/verify` stays open and says nothing about the payment. The Wardy Network and `/health` stay public. The browser's `EventSource` can only send a credential in the URL, so the dashboard reads the stream with `fetch`. Offline, the dashboard uses the public demo credential, and on testnet or live the owner signs in, in that tab only. |
| 24 | Approval link carries `?token=` | Browsers send the query string to the server, so it lands in access logs, and in `Referer` headers. | The token goes after the `#`, which browsers never send. The page moves it to session storage and clears it from the address bar. Fonts ship with the app and the page sends no referrer, so it calls nobody. Added `POST /v1/approve/:id/preview`: a phone has no other credential, so the token also reads that one payment, without being spent. A wrong token and an unknown payment look the same, so ids can't be probed. |
| 25 | Header chip says "Policy signed · provider"; "Only Wardy can pay" | Offline there's no signed policy, and testnet doesn't have one either. The product isn't called just "Wardy". | The chip says "Demo policy" offline and "Test policy" on testnet, and only says "signed" in live mode. Copy says "Wardy Agent" throughout, and a test enforces it. A8's forged line changed to match, which changed no decision: the anchored reports still match byte for byte. |
| 26 | Report payee button; "or owner confirmation" (principle 3) | Reports needing two kinds of evidence publish by themselves, so the button only matters for the other path, which wasn't built. | Built. A BLOCK, or a held payment the owner rejected, can be reported on one kind of evidence. `ownerConfirmed` is covered by the leaf and the signature, so it can't be added or stripped, and a reader can weigh it. It never applies to a known payee, a check, or a broken limit alone. Normal reports' leaves are unchanged, so nothing anchored moved. The owner can also withdraw a report from the Network screen. |
| 27 | `npm run dev` starts api + web + mcp | MCP servers run over stdio, launched by the AI client. One started here would have no one to talk to. | `scripts/dev.ts` starts the API and dashboard, and points at docs/MCP_SETUP.md. `apps/api/src/server.ts` is gone. Added `--fresh` (offline only) and `--lan` (refused in live mode, because the owner's credential would cross Wi-Fi unencrypted). |
| 28 | Dashboard screens only | A visitor with no agent attached would see an empty feed. | Offline only: **Play demo traffic** sends real requests through the real API, and **Run Attack Lab** streams a real run. Neither exists in testnet or live mode. The traffic's lookalike (`g1obex-supply.near`) isn't in the seeded feed, so its report really is created live, and the reason shown is the lookalike rather than "already reported". The lab's rows are revealed at a readable pace, and the rows are the real results. |
| 29 | Study nearhackathon.com and solana.com for polish | nearhackathon.com wouldn't load in the built-in browser (`ERR_CERT_AUTHORITY_INVALID`). I didn't work around a certificate error. | Studied solana.com only: confident type at medium weight with tight tracking, 200 ms transitions, respect for reduced motion. Shurik should compare the result with nearhackathon.com. |
| 30 | Motion spec | A browser allows six connections per site, and a live feed holds one. | The feed closes when a page is left or a tab is hidden, and catches up when shown. Before this, about six full page loads of different addresses hung the whole dashboard, because the browser kept each old page alive in its back/forward cache with its connection still open. A plain reload of one address doesn't do it. `npm run test:ui` runs in CI to keep it fixed. It's a real browser, using `puppeteer-core` and `axe-core` as dev dependencies, and needs Chrome. |
| 31 | Hero: a faint dot field under 5% visual weight. "Don't copy" the reference sites | **Shurik, 2026-11-02:** wants the sphere of letters from nearhackathon.com, moving with the mouse: agentic, modern, AI native, simple and interactive. That overrides the 5% rule. | **Approved by Shurik, 2026-11-02**, keeping our own colours and rounded corners. Our own code, and the README credits the idea. It's made of the characters account names use. A verdict sends a wave across it in its colour, the payee's name spells out below, and the thin lines point at live data, so it still follows the brief's rule that motion explains something. It can be paused, stops when off screen, and doesn't turn with reduced motion. Colours and type stay our own, with mono labels added across the console. |
| 32 | Three MCP tools, and `GET /v1/verdicts/:id` for reading results | Using it as an agent found a dead end. Once verdicts needed the owner's credential, an agent told HOLD could never learn what the owner decided, so it would wait forever or retry. | Added `wardy_status` and `GET /v1/pay/:id/status`, for the agent's credential, which say only the outcome. Every answer has a `nextStep`, and MCP tools also return structured data. Bad requests say what to fix. Added `/llms.txt`, a root index, `AGENTS.md`, and a **For agents** screen with a real check to try, inspired by market.near.ai and Browserbase. |
| 33 | Study nearhackathon.com | It now loads (an earlier certificate error was temporary). | Also studied x402.org, solanamobile.com, colosseum.com, ethglobal.com, near.ai, market.near.ai, browserbase.com and cursor.com. No branding, logos or layouts were copied. |
| 34 | Decision 31's letter sphere; a light console | **Shurik, 2026-11-03:** wants a design in the spirit of near.org and nearhackathon.com, with an animated background, but said plainly not to copy them, and named the sphere as something copied. | The sphere is gone. Replaced with the checkpoint: payments stream through one shield-shaped gate, which is what the product does. The background is our own glass shield with its eyes, drawn live by WebGL rather than a video, so it needs no download, works offline, and reacts to verdicts. No dot grid or pixel numerals, and the headline stands beside the shield rather than on it. Indigo was tried first. **Shurik, 2026-11-03,** preferred neon green on near-black, which is close to NEAR's own green, so that's what ships. **Also Shurik:** the background must react to everything you do, and round eyes looked crazy. So eyes are two calm slits of light that watch your pointer or the field you're typing in, close during a credential, and narrow at a BLOCK. A press sends a ring from that spot, a hover lifts the glow, scrolling turns the shield, and freezing turns it orange. The checkpoint now says what it shows in plain words. NEAR's logo and video aren't used anywhere. The approval page gets the look with nothing moving. |
| 35 | Five detectors, and the rules stay frozen at `2bb78b8` (supersedes the five in CLAUDE.md) | Competitor review: limits are one number for all payees, so an API charging 0.01 can ask for 2.5 and pass. Shurik chose this gap on 2026-11-03. | **Added D6, unusual amount.** After 3 settled payments to a payee in one asset, an amount above 3 times the median and above the highest ever paid forces HOLD, never BLOCK. Ignored below 0.5 units. It isn't report evidence, and it doesn't run on a public `check`, because trying amounts there would reveal what the owner pays. The 3 times was chosen for "far more than usual", and it doesn't catch the holdout's 1.5 times surcharge (B4). The old holdout's results didn't change. A new holdout (C, HC) was written after this rule froze at `9a0bce6`, and wasn't tuned after: 5 of its 6 attacks took money, and 1 of 4 honest payments was held. |
| 36 | `/v1/check` is public for everyone | Anyone sending this owner's id got answers built from their history and limits, though the threat model said those need a credential. Found 2026-11-03, and Shurik approved the fix. | **A check using this owner's id needs the agent's or owner's credential, otherwise 401.** Other owners' checks stay free, and they never saw this owner's data. The rule files didn't change, so the holdout freeze at `9a0bce6` holds. |
| 37 | Decision 34's glass shield | **Shurik, 2026-11-03:** the glass looked unclear. Compared five versions live (sharp glass, neon tube, liquid metal, solid visor, built from blocks) and chose **built from blocks**, suggested by Shurik, who liked the checkpoint's animation. All green, no white, and no payments flying through it, because the checkpoint below already shows those. | The shield is now small separate blocks on a plain canvas, in the checkpoint's style. WebGL is gone, so there's no shader to compile and no separate no-WebGL case. The reactions stay: it watches the pointer or the field you're typing in, closes its eyes during a credential, narrows them at a BLOCK, sweeps in each verdict's colour, and bursts apart at a BLOCK. Row 34's "no dot grid or pixel numerals" still holds for the page; this is Shurik's choice for the shield only. The X images are redrawn from the same code. |
| 38 | The AI's effect was unknown, because no real answers existed | Shurik added a NEAR AI Cloud key on 2026-11-03. 38 answers recorded on `z-ai/glm-5.3-flash`, all from calls that passed the full attestation check. | **Results now replay these answers.** Holdout: 7 of 14 attacks still took money, down from 8, with B2, B3 and B6 stopped harder. New false block: HB5, because the AI read an ordinary "admin approved" as asking to bypass rules, and that alone blocks. Not tuned, because that would be a rule change. A9 goes from HOLD to BLOCK with the AI; its deterministic result is still tested. The changed reports were appended to the feed and re-anchored at [this transaction](https://testnet.near.rocks/tx/15XbDhPDB6258kmAedsKvvsrfJxX9nECnqmuTz5d4KJ). |

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
- **Decision:** Agent Connect is the live provider. Since it has no testnet, `WARDY_MODE=testnet` uses OutLayer testnet (`packages/providers/src/custody/outlayer.ts`), so real transactions run end to end with no real money. The adapter refuses mainnet URLs, because it sends native NEAR, which skips the rules we rely on in live custody. Set up with `npm run setup:testnet`.

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
- **LIVE, 2026-11-03, no key:** the attestation report is public, and `provider=near` reports do return for `glm-5.3-flash`. `npm run hello:attestation` passes 4 of the 8 checks against the live service: NVIDIA GPU evidence, Intel TDX quote (`UpToDate`), and the quote binding the signer and our nonce. This does not mark any verdict attested, because the other 4 tie a real answer to this evidence.
- **TODO-VERIFY:** the service accepts our exact chat request, and its signature is `provider_tee` from a signer in the report. `npm run hello:ai` settles both once there is a key with credit. Never fake a result: anything less than all eight checks shows as `partial`.
- **Credits, 2026-11-03:** joining NEAR Builders and signing in to NEAR AI Cloud with the same wallet (`Sign in with NEAR`) showed $0.00, as did a Google sign-in. Neither page says how to claim the $10 from Q-000, so Shurik asked in the builders chat. Wallet accounts can only pay with crypto; the page says card top-up needs a Google or GitHub account.

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

**Wardy Network anchor (LIVE, 2026-11-02):** `wardy-agent-registry.testnet` holds a real root over 6 leaves: [transaction](https://testnet.near.rocks/tx/HqqwfzdWxs4TnVGqgCmHygAo2EE1aUidkqqAhZH5vuqp). I re-computed the root in separate Python code and read it back from two RPC providers. The feed is `config/network-feed.testnet.jsonl`, and `npm run network:verify` repeats the check. The tree is RFC 6962, checked against its published vectors.

- **Deployed (LIVE):** [`wardy-agent-registry.testnet`](https://testnet.near.rocks/account/wardy-agent-registry.testnet). Addresses and tx hashes: `config/registry.testnet.json`. The first two anchored roots were labelled dummies from `npm run hello:contract`, to prove the contract works. Real anchors start at the third: see above. The on-chain code hash `7pUhLfAo…` equals the bs58 SHA-256 `cargo near build` printed. The account's history shows the two anchor attempts from a non-reporter, both refused on-chain.
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
| Dashboard fonts come from npm (`@fontsource-variable/*`, OFL), not Google Fonts | A clean clone works offline, and the approval page calls nobody |
| Commits use the GitHub no-reply email | The repo goes public; this keeps a personal email out of its history |
