# Demo script

2 minutes 30 seconds, for the required video. Only Shurik records it and posts it on X. The post has to say it was built at NEAR HACKATHON, tag @NEARProtocol and #NEARHackathon, and include the video.

## Before you record

1. Close other windows, and hide notifications.
2. Start clean:
   ```bash
   npm run dev -- --fresh
   ```
3. Open <http://localhost:5173> in a browser window about 1440 wide.
4. Keep a terminal open, with large text, in the project folder.
5. To record your Mac's screen, press Shift + Command + 5. You don't need other software.

The payments are made-up, on a mock ledger. Keep the **Demo data** badge in the shot. Don't crop it out.

## The shots

| Time | Show | Do | Say |
|---|---|---|---|
| 0:00-0:15 | The hook | In the terminal, run `npm run agent -- --scenario lookalike`. Scroll to what the agent read | "Spending limits don't stop this. This agent reads an invoice saying the account has moved, and it's ready to pay a lookalike." |
| 0:15-0:35 | Live checks | Show the headline. Open **Policy** and point at **Wardy Agent only** | "The agent holds no keys. Only Wardy Agent can pay, and only after it checks who is being paid and why." |
| 0:35-0:55 | Honest and lookalike | Back on **Live checks**, press **Play demo traffic**. The page scrolls to the checkpoint. Watch the gate: the ALLOW goes through, then the BLOCK of `g1obex-supply.near` breaks apart in orange, with its name spelling out below. Click its row | "An honest invoice passes. This one is blocked: one character from a payee you've really paid, on a brand-new account." |
| 0:55-1:20 | The phone | Close the panel. Under **Waiting for you**, press **Review**. Press **Reject — don't pay twice** | "A tool claimed the payment failed. It didn't, so Wardy Agent asks me. One tap, and nothing is paid twice." |
| 1:20-1:40 | Private AI | **Record this shot separately**, because the offline demo can't show the tick. See "The private AI shot" below | "Read privately in a TEE on NEAR AI Cloud, with its attestation verified." |
| 1:40-2:00 | The network | Open **Network**. Show **Protected by the network**, then search `acme-sh0p.near`, and press **Check the contract** | "When one agent is attacked, every agent learns. Evidence, not votes, with the root anchored on NEAR." |
| 2:00-2:15 | Earning | **Only once a real sale exists:** open **Earnings** | "Another agent paid for this check. Wardy Agent earns by protecting agents." |
| 2:15-2:30 | The numbers | Open **Attack Lab**, press **Run Attack Lab**, and let the totals land. Then scroll to the holdout | "With and without, on the same inbox. And here's what it still misses, because we publish that too." |

## The private AI shot

Set this up before you record, so your credential never appears on screen:

1. Start the testnet server next to the demo:
   ```bash
   WARDY_MODE=testnet WARDY_WEB_PORT=5175 WARDY_API_PORT=8789 npm run dev
   ```
2. Open <http://localhost:5175> and sign in with `WARDY_OWNER_TOKEN` from `.env`. Stay off camera for this.
3. Then open <http://localhost:5175/?verdict=f643604a-5701-43d3-896b-77dcb6d0cd28>, and record the **Read privately** box.

## If a shot isn't ready

- **No real attested verdict:** skip the private AI shot. The offline demo replays recorded answers, so its box says the attestation isn't verified, and that's the truth.
- **No real sale:** skip the earning shot, or show **Earnings** and say it isn't listed yet.
- **Give the time to the Attack Lab.** It's the strongest moment anyway.

## Rules for the video

- Don't say or show a number that a run didn't produce.
- Say that the "without" column is a scripted worst case, if you quote it.
- If you quote the main-set totals, show the holdout too.
- Never show a real key, your `.env`, or a real approval link for real money.
