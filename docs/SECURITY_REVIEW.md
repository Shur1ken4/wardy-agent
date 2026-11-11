# Security review, 2026-11-11

An adversarial pass over the code and a local copy of the hosted server, done the way a hostile agent or person would.
The live server got only ordinary requests. Everything found was fixed in commit `bf7a91b` and the one after it, each
with a test. Attack Lab results did not change by a byte.

## Every attack tried

| # | Attack | What happened | Problem? | Fix |
|---|---|---|---|---|
| 1 | Pay a lookalike: swapped characters, repeated letters, `_` for `-`, a different ending, the name wrapped in words | All blocked or held (`LOOKALIKE_*`) | No | |
| 2 | A paid payee's whole name run into another: `acmeshop-pay.near`, `payacmeshop.near` | Not flagged | **Yes, medium** | Now a suffix trick, for payees the owner really paid, names of 6+ (`lookalike.ts`) |
| 3 | Upper case, a space, a Unicode hyphen, punycode in the payee | Refused: not a NEAR account (`CHAIN_ADDRESS_MISMATCH`), or not testnet on the hosted server | No | |
| 4 | Prompt injection in invoice, email and tool result: plain, other wording, `system:` lines, tags | Blocked (`CONTEXT_BYPASS_ATTEMPT`) | No | |
| 5 | The same phrase with a zero-width space, soft hyphen, full-width letters, a Cyrillic `і`, non-breaking spaces | **Not seen by the patterns.** With the AI on, it would still add risk; offline, nothing fired | **Yes, high** | Patterns and the invoice hash read a folded copy (`text.ts`): format characters removed, look-alike letters mapped. Tested on 7 variants |
| 6 | "Payment failed, send again" with hidden characters | Same miss | **Yes** | Same fix |
| 7 | Can the AI lower a score or turn BLOCK into ALLOW? | Structurally no: its findings only ever add signals, low confidence is ignored, and the regexes run regardless. Existing tests cover every answer it could give | No | |
| 8 | Amount inflation, payee swap with the same invoice text, splitting into small payments | Held or blocked as designed. Splitting past the first approval stays inside the owner's limits, which is the limits' job | No | |
| 9 | Agent approves its own HOLD, renews a link, freezes, reads the owner's history | 401 everywhere. The token appears in nothing an agent reads | No | |
| 10 | Agent learns the limits by asking | A refusal names the limit it broke | Accepted | Documented as a known limit: it needs the reasons, and can't change the numbers |
| 11 | Two owners: A approves, reads, renews or freezes B's payments, with and without B's tenant key in the link | 401 or 404 each way. A freeze touches only its own owner | No | |
| 12 | Sign-in: replay a nonce, wrong recipient, function-call key, a mainnet account, sign-out, the 10-session cap, old agent token after rotation | All refused or ended as designed. A mainnet account can sign in but can only pay testnet names | No | |
| 13 | Approval links: guessing (256-bit token), reuse, 30-minute expiry, Referer, logs, history, framing, CSRF | Token is after the `#`, stored hashed, single use; `no-referrer`, `frame-ancestors 'none'`; JSON body only | No | |
| 14 | Get an innocent old account reported: an injected invoice sent three times (`CONTEXT_BYPASS_ATTEMPT` + `VELOCITY_NEW_PAYEE`) | **A report was published.** Both "kinds of evidence" were the sender's own text and timing | **Yes, high** (reputation) | A report needs one kind about the account itself: lookalike or new-account (`network/report.ts`). Readers check it too, so an old report of that shape no longer counts. Every anchored report already qualifies |
| 15 | Fill the disk from one address: 200 sandboxes × 120 payments a minute | Each payment is 2.6 KB on disk; one address could write about 60 MB a minute | **Yes, high** (availability) | 5 sandboxes per address, 2,000 requests per sandbox, 1,000 requests per owner a day |
| 16 | Fill the public demo's ledger with free checks | Grew 0.4 KB per check, on disk, forever | **Yes, medium** | The public tenant keeps nothing on disk and only its last 2,000 verdicts |
| 17 | Evict every visitor's sandbox by making 200 of your own | Worked | **Yes, medium** | An address past its share evicts its own oldest, never anyone else's |
| 18 | Burn the shared NEAR AI credit from one owner | One owner could use all 500 daily reads | **Yes, low** | 50 per owner a day, inside the server-wide 500 |
| 19 | CPU: `/v1/verdicts/{id}/verify` had no rate limit | A signature check per call, unlimited | **Yes, low** | 120 a minute per address |
| 20 | X-Forwarded-For spoofing, oversized bodies, bad JSON, odd amounts (`1e3`, `0x10`, Arabic digits, 49 digits), extra fields, path traversal in the static server | All refused with a plain message; traversal gets the dashboard page, never a file outside it | No | |
| 21 | An unknown field name echoed in the error (`Unrecognized keys: "..."`) | The sender's text came back in an error an agent reads | **Yes, low** | Says a field isn't part of the request, without naming it |
| 22 | XSS: anything rendered as HTML, eval, innerHTML | None in the source; React escapes; CSP `script-src 'self'` | No | |
| 23 | Secrets in git history, logs, errors, API answers; `npm run check:secrets` | Clean. Logs carry method and route only; `.dockerignore` keeps `.env` and `.data` out of the image | No | |
| 24 | Wardy Network: edit a report, forge a withdrawal, mismatch the Merkle root, replay another reporter's report | Every change fails a signature, the root is recomputed, untrusted keys don't count | No | |
| 25 | Supply chain: unpinned ranges, releases under two weeks old, lifecycle scripts, lockfile integrity | Caret ranges everywhere; 6 direct dependencies under two weeks old; no foreign install scripts; every lock entry has a hash | **Yes, low** | Everything pinned exactly, 5 of the 6 moved to older releases, `npm run check:deps` in CI. The Intents SDK stays at 0.7.3: it's the release run with real funds |

## Not fixed, and why

- **Relay phishing of sign-in** and **many addresses beating per-address limits**: known limits of a public testnet
  server. The wallet shows which site a signature is for, and the money limits don't depend on addresses.
- **Owners' folders persist.** 500 hostile owners, each at their daily cap, could write about 1.3 GB a day. The volume
  is 1 GB. Watch it; the fix is a per-owner data cap, which would mean forgetting an owner's history.
- **Two held copies of one payment** can both be approved: each shows the owner the amount and payee, and it's their call.

## The one command for a judge

```bash
npm test -- --reporter=dot packages/core/test/contextTamper.test.ts packages/core/test/lookalike.test.ts packages/core/test/networkReport.test.ts scripts/test/hosted.test.ts scripts/test/hosted-owners.test.ts
```

It ends in `Tests  … passed`, and the names it runs are the attacks above: hidden characters, wrapped names, a smear
with the sender's own evidence, one address crowding out others, and one owner using up what's shared.
