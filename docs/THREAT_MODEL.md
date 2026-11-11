# Threat model

The adversarial review of 2026-11-11, with every attack tried and what came of it: [SECURITY_REVIEW.md](SECURITY_REVIEW.md).

What Wardy Agent protects, from whom, how, and where it stops. Where something isn't defended, this says so.

## Assets

| Asset | Why it matters |
|---|---|
| The owner's funds | The point of the project |
| The spend grant | Whoever holds it can spend |
| The verdict signing key | Whoever holds it can write verdicts and reports |
| The owner's private text: invoices, emails, tool results | It may hold business secrets |
| The owner's payment history and limits | They reveal who an owner pays, and how to stay under the limits |
| An innocent payee's reputation | A public report names them |
| The owner's credential and approval links | They can release held payments |

## Attackers

| Attacker | Can | Can't |
|---|---|---|
| Someone sending a poisoned invoice or email | Put any words in front of the agent | Touch Wardy Agent directly |
| A scammer registering a lookalike account | Make a name close to a real payee's, and age it if patient | Be a payee the owner has already paid |
| A hijacked or buggy worker agent | Ask to pay anything, as often as it likes | Spend, approve its own HOLD, or unfreeze |
| Another agent on the API | Send a `check` | Move money, or create a report |
| Someone poisoning the Wardy Network | Write any report, signed with its own key | Sign with a key readers trust |
| A relay passing reports along | Change or drop what it forwards | Forge a signature, or match an anchored root |

## Attack paths and what stops them

| Attack | What stops it | Where |
|---|---|---|
| Worker agent skips the check | It has no keys or grant, so there's no other path to the money | Setup, [MCP_SETUP.md](MCP_SETUP.md) |
| Lookalike payee | Lookalike detector, and new-account detector | `detectors/lookalike.ts`, `detectors/newAccount.ts` |
| Fake "payment failed, please retry" | Duplicate detector compares with what really settled. Payments run one at a time | `detectors/duplicate.ts`, `service.ts` |
| Invoice hides a phrase with invisible or look-alike characters | The built-in patterns read a folded copy: zero-width and format characters removed, full-width letters and Cyrillic look-alikes mapped to Latin | `text.ts` |
| Invoice tries to instruct the model | Text is data: it's never in a system prompt as instructions. The AI can only add risk, and rules decide | `decision.ts`, `ai/nearAiAnalyzer.ts` |
| Invoice swaps the payee | Context tamper detector | `detectors/contextTamper.ts` |
| Splitting into small payments | Velocity check on payees never paid | `detectors/duplicate.ts` |
| Paying on the wrong chain | Cross-chain format check | `detectors/crossChain.ts` |
| Over the limit | Owner policy, then the provider's limits on real custody | `policy.ts` |
| Agent approves its own HOLD | The one-time token goes only to the owner, and appears in nothing an agent can read. Tests confirm it | `service.ts`, `app.ts` |
| Approval link stolen from a log | The token sits after the `#`, which browsers never send, and it's removed from the address bar. It's stored hashed, is single use, and expires in 30 minutes | `wiring.ts`, `Approve.tsx` |
| Approval page wrapped in another page to trick a tap | It refuses to show inside a frame | `Approve.tsx` |
| Hostile text shown on the dashboard | React escapes it, and a test scans the source for raw HTML | `apps/web/test` |
| Payment history read from the API | The owner's credential is required. A worker agent can read a payment's outcome, and nothing else about the owner | `app.ts`, `service.ts` |
| An agent retries because it doesn't know what happened | `wardy_status` tells it, and every answer carries a `nextStep` | `nextStep.ts`, `apps/mcp/src/tools.ts` |
| Fake reports flood the network | Only trusted keys count, and nothing is counted | `network/lookup.ts` |
| Real evidence attached to someone else's name | The report must match its signed verdict, and anyone can check | `network/report.ts` |
| Relay edits a report | The reporter signs the leaf, so any change fails | `network/report.ts` |
| Forged withdrawal, to get off the list | It must be signed by the report's own reporter, or it's ignored | `network/report.ts` |
| Rewriting the feed's history | The contract refuses a shrinking count, or a new root at the same count | `contracts/registry` |
| Dummy root replaces a real one | `hello:contract` refuses, and a test checks it | `scripts/registry.ts` |
| A secret committed to git | Secret check in the pre-commit hook and CI | `scripts/check-secrets.mjs` |
| A hijacked dependency release | Every direct dependency is pinned to one exact version, the lockfile carries every integrity hash, and CI checks that each pinned release has been on npm for two weeks (one documented exception) | `scripts/check-deps.mjs` |
| Too much at stake in live mode | Refuses to start above 10 NEAR equivalent unless told otherwise | `wiring.ts` |
| Abuse of the check endpoint | Rate limit on `/v1/check`, and on network lookups | `app.ts` |
| A stranger reads the owner's payees and limits by asking as them | A check using this owner's id needs the agent's or owner's credential. A refusal does confirm that id is this server's owner, which is an account name and not a secret | `app.ts` |

## Known limits

These are real gaps, not edge cases.

1. **Quiet fraud from a real payee gets through.** The newest holdout shows it: all 5 of its attacks took money, by staying just inside the thresholds (E1 to E5). Across every set, 10 of 23 did. Each paid a payee the owner really pays, under every limit, so a scammer has to be that payee or control its account. The amount checks catch big jumps and big totals, but anyone who knows the numbers can stay under them. Checks only hold, so they also interrupt honest payments: a real yearly plan (HC1), a first payment in a new asset (HC3), a busy API day (HE1), and an ordinary "your admin approved this", which on such a payee holds and doesn't block (HB5, HD1). An owner who believes a fake claim can approve and pay it (C6). A public `check` skips the amount checks on purpose, so a `check` can say ALLOW where the payment is then held.
2. **Smearing an innocent account.** An attacker can send an invoice naming a brand-new or lookalike account, and it could get reported. A `check` can't publish, a report needs two kinds of evidence, one of them about the account itself (so an injected invoice sent three times can't get an old, honest account reported: that was possible until 2026-11-11), and it can be withdrawn. But there's no dispute process.
3. **A patient scammer.** An old, active account that doesn't resemble anyone only reaches HOLD, and is safe only if the owner rejects it (B2, B5).
4. **An owner who approves everything.** HOLD asks a person, and a person can be fooled or tired.
5. **A withdrawal can be missed.** Someone holding one report and its proof can't tell if it was later withdrawn. Only the whole feed shows that, up to the last anchor.
6. **Reports are public.** They name the payee, the imitated name, the score, the codes, the time and the reporter's key. That key can link an owner's reports together.
7. **The audit log is local.** Its chain shows tampering after its head is shared, but whoever holds the file could rewrite it all before that.
8. **The offline signing key is public on purpose.** It's for demos only: seed reports never count in testnet or live decisions.
9. **An agent learns the numbers it broke.** A refusal says which limit it crossed, so a hijacked agent can learn the limits by asking. It can't change them, and the owner's own payment history still needs the owner's credential.
10. **`--lan` isn't encrypted.** It's refused in live mode, but on testnet the owner's credential crosses your Wi-Fi in the clear.

## The hosted server

`npm run serve` runs Wardy Agent for strangers on the internet (the Fly.io deploy). It only ever uses testnet: free test
tokens, from one shared OutLayer testnet wallet. A visitor gets an offline sandbox; a visitor who signs in with a NEAR
wallet gets a testnet agent of their own.

**More assets here:** the shared test wallet, the NEAR AI credit (each private check spends a little of it), the server's
disk and memory, and each owner's session and agent token.

**More attackers here:** anyone on the internet, with as many free testnet accounts and as many IP addresses as they like.

| Attack | What stops it | Where |
|---|---|---|
| A real mainnet key or payee ends up on the server | It refuses to start with mainnet keys. A payee must be a `.testnet` or implicit account, so no report can name a real mainnet account | `scripts/serve.ts`, `app.ts` |
| Strangers' verdicts signed with the key that signed real mainnet ones | It refuses to start with `WARDY_SIGNING_KEY` and makes its own key, kept on its disk | `scripts/serve.ts` |
| Signing in as someone else | The wallet signs a one-time challenge (NEP-413) naming this site, and the key must be a full-access key of that account, checked on NEAR RPC. Each challenge works once, within 5 minutes | `scripts/auth.ts` |
| One owner reads or approves another's payments | Each session and agent token maps to one owner's own data folder. Tests try it both ways | `scripts/hosted.ts` |
| Faking your address to skip every rate limit | The server believes only the address added by Fly's own proxy (`WARDY_PROXY_HOPS=1`), not one a visitor writes into `X-Forwarded-For` | `scripts/serve.ts`, `app.ts` |
| Emptying the shared test wallet with many free accounts | Each owner may pay 0.02 at a time and 0.1 a day, and the whole server 1 a day (`WARDY_POOL_DAILY_LIMIT`). Past that, a payment fails before anything is sent | `config/policy.hosted.json`, `PoolDailyCap` |
| Sign-up spam | 3 new owners per address a day, 500 owners in all, 10 sessions per owner | `scripts/serve.ts`, `scripts/auth.ts` |
| Burning the NEAR AI credit | 500 private checks a day for the whole server (`WARDY_AI_DAILY_LIMIT`), and 50 per owner (`WARDY_AI_OWNER_DAILY_LIMIT`) | `scripts/hosted.ts` |
| Filling the disk or memory | `/v1/pay` 120 a minute per agent and 1,000 a day per owner (`WARDY_OWNER_DAILY_REQUESTS`), 5 live feeds per owner, 200 sandboxes (5 per address, 2,000 requests each) cleared after 2 idle hours, and the public demo keeps nothing on disk and only its last 2,000 verdicts | `app.ts`, `scripts/hosted.ts` |
| A broken address crashing a request | Bad paths get "not found", never a server error | `scripts/serve.ts` |
| The page being framed, or loading someone else's script | Strict security headers: CSP, no framing, no referrer, HTTPS only | `scripts/serve.ts` |

**Known limits of the hosted server:**

1. **Relay phishing.** A fake site could pass along our sign-in challenge and get a visitor to sign it, then use their
   session. The wallet shows which site the message is for, and the most it can reach is that visitor's test agent.
2. **Many addresses beat per-address limits.** Someone with many IPs can still fill the 500 owner places, or churn
   sandboxes. The money limits don't depend on addresses, so the test wallet stays safe.
3. **Sessions live in memory.** A restart signs everyone out. Owners' data and agent tokens stay on the disk.
4. **One shared wallet.** Owners' limits are enforced by Wardy Agent, not by the custody provider, so on this server the
   operator is trusted for them too.
5. **The operator can see everything.** Whoever runs the server can read every owner's payments and private text. That's
   why it carries test tokens only.

## Out of scope

- **A compromised Wardy Agent operator.** Whoever runs it holds the grant and the signing key, so they can spend within the provider's limits and sign anything. Running it in a TEE is on the roadmap.
- **A compromised custody provider or NEAR AI Cloud.** We trust the provider's limits. Attestation checks where the AI ran, not whether it's right.
- **A compromised owner's device.**
- **Sanctions, tax and legal checks.**
- **Attacks on NEAR itself.**
