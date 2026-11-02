# Setup guide for Shurik

You need about 15 minutes for Steps 1 to 4. You don't need to code. **Don't send any money yet**; Phase 1
tells you exactly when and how much.

**One rule for all of this:** keys go only in the `.env` file. Never paste a key into this chat, a
screenshot or anywhere else.

To open `.env` once it exists, run this in the project folder. It opens in TextEdit:

```bash
open -e .env
```

## What it costs

| Item | Cost |
|---|---|
| NEAR AI Cloud | Free $10 credit through NEAR Builders. A check costs about $0.0002 |
| Agent Connect key | No fee stated in the docs |
| Testnet | Free, and I handle it |
| Real test payments | Under 2 NEAR to start, about $8 at today's $4.13. Hard limit for the whole project: 5 NEAR |
| Agent Market paid hire (later, optional) | The job price you set, probably under $1 |

## Step 1: NEAR AI Cloud key (needed)

This is the private AI that reads invoices.

1. Go to https://nearbuilders.org/join and join. This is what gives you the $10 credit.
2. Go to https://cloud.near.ai, sign in, and check the credit shows on the dashboard. If it doesn't, tell
   me what you see.
3. Create an API key in the dashboard and copy it.

You paste it in Step 4.

## Step 2: Agent Connect key (needed)

This is the service that holds the agent's money under rules you sign.

1. Go to https://partners.near-intents.org/ and sign up or sign in.
2. Open **API keys** and create one. It starts with `naa_` and **is shown only once**, so copy it right away.

I couldn't test this sign-up myself. If the portal won't let you in, try the demo portal instead:
https://partners.demo.agentsonintents.com/. Its keys are temporary, and you'd also need to change one line
in Step 4. Tell me which one worked.

Both are real mainnet with real money, which is why we keep the amounts tiny.

## Step 3: Create your project keys (needed)

Run this once in the project folder:

```bash
npm run setup:keys
```

You should see `Saved new keys to .env`, plus two long account names. It creates two brand-new NEAR accounts
just for this project:

- **Owner:** signs the agent's rules. It holds very little, and you never have to export the seed phrase
  from your real wallet.
- **Test merchant:** receives our real test payment, so no money goes to a stranger.

**Back up `.env`** somewhere private, such as a password manager. If it's lost, any funds on these accounts
are lost. Don't send anything to them yet.

## Step 4: Paste the keys and check

Open `.env` with the command at the top and fill in these lines. Paste with no spaces or quotes:

```
NEAR_AI_CLOUD_API_KEY=your key from Step 1
NEAR_INTENTS_AGENT_API_KEY=your key from Step 2
```

If you used the demo portal in Step 2, also change this line:

```
NEAR_INTENTS_AGENT_API_URL=https://api.demo.agentsonintents.com
```

Save the file, then run:

```bash
npm run setup:check
```

You should see `OK` on four lines and `All set for Phase 1.` The owner line will say "not on-chain yet",
which is normal. This check only reads; it moves no money. If a line says `MISSING` or `FAILED`, send me that
line. It never prints your keys, so it's safe to share.

## Step 5: Your payout account (needed before submitting, not now)

The prize is paid to a NEAR mainnet account that you own, such as `yourname.near`, from any NEAR wallet. Use
your normal wallet, not the project accounts above. It only goes in the submission form, never in the repo.
I can't create or choose this for you.

## Things you'll do later (I'll tell you when)

| When | What | Why it has to be you |
|---|---|---|
| Phase 1 | Send about 0.5 NEAR to the owner account, then fund the agent with about 1 NEAR | Real money: you run or approve every transfer |
| Phase 1 and 3 | Run one command for each real test payment | Same reason. I write the script and tell you what you should see |
| Phase 7, optional | Sign up at https://market.near.ai and create the listing | Website account, confirmed email |
| Phase 7, optional | Create a Telegram bot with @BotFather | Your Telegram account |
| Nov 14 | Record the video, post on X, confirm the submission | Only you can post or confirm |

## Testnet (nothing to do)

I'll create the free testnet accounts from a script in Phase 1. If the faucet refuses, I'll ask you to use
https://near-faucet.io, which takes a minute.
