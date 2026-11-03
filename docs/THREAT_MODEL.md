# Threat model

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
| Too much at stake in live mode | Refuses to start above 10 NEAR equivalent unless told otherwise | `wiring.ts` |
| Abuse of the check endpoint | Rate limit on `/v1/check`, and on network lookups | `app.ts` |
| A stranger reads the owner's payees and limits by asking as them | A check using this owner's id needs the agent's or owner's credential. A refusal does confirm that id is this server's owner, which is an account name and not a secret | `app.ts` |

## Known limits

These are real gaps, not edge cases.

1. **Quiet fraud from a real payee gets through.** The holdout shows it: 7 of 14 attacks still took money. Each was a payee the owner really pays, under every limit. With real answers replayed, the private AI stopped B3 "pay the remainder", but B4 a small fee and B7 a reissued invoice still got through.
   The unusual amount check catches a big jump (A10, C5), and it stopped C1 late. It doesn't catch a price that creeps up (C1 lost 0.54 USDC first), a payee with fewer than 3 payments (C2), a different asset (C3), amounts under 0.5 (C4), or repeats after one approval (C6). It also holds some honest payments, like a real yearly plan (HC1). The AI added a false block of its own: an ordinary "your admin approved this" reads as asking to bypass rules, and that blocks a real invoice (HB5). Worth noting: a public `check` skips it on purpose, so a `check` can say ALLOW where the payment is then held.
2. **Smearing an innocent account.** An attacker can send an invoice naming a brand-new or lookalike account, and it could get reported. A `check` can't publish, a report needs two kinds of evidence, and it can be withdrawn. But there's no dispute process.
3. **A patient scammer.** An old, active account that doesn't resemble anyone only reaches HOLD, and is safe only if the owner rejects it (B2, B5).
4. **An owner who approves everything.** HOLD asks a person, and a person can be fooled or tired.
5. **A withdrawal can be missed.** Someone holding one report and its proof can't tell if it was later withdrawn. Only the whole feed shows that, up to the last anchor.
6. **Reports are public.** They name the payee, the imitated name, the score, the codes, the time and the reporter's key. That key can link an owner's reports together.
7. **The audit log is local.** Its chain shows tampering after its head is shared, but whoever holds the file could rewrite it all before that.
8. **The offline signing key is public on purpose.** It's for demos only: seed reports never count in testnet or live decisions.
9. **`--lan` isn't encrypted.** It's refused in live mode, but on testnet the owner's credential crosses your Wi-Fi in the clear.

## Out of scope

- **A compromised Wardy Agent operator.** Whoever runs it holds the grant and the signing key, so they can spend within the provider's limits and sign anything. Running it in a TEE is on the roadmap.
- **A compromised custody provider or NEAR AI Cloud.** We trust the provider's limits. Attestation checks where the AI ran, not whether it's right.
- **A compromised owner's device.**
- **Sanctions, tax and legal checks.**
- **Attacks on NEAR itself.**
