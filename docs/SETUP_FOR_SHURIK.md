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
| Real test payments | 0.5 NEAR to start, about $2 at today's $4.13. It stays on accounts you hold the keys to. Hard limit for the whole project: 5 NEAR |
| Agent Market paid hire (later, optional) | The job price you set, probably under $1 |

## Step 1: NEAR AI Cloud key (needed)

This is the private AI that reads invoices.

You don't need to know this key in advance. The website makes it for you, and you copy it once.

1. Go to https://nearbuilders.org/join and join. This is what gives you the $10 credit. The page asks you
   to connect a NEAR wallet, so you need one first. If you make a new one and it shows you a recovery
   phrase, write the phrase on paper and never send it to anyone, including me.
2. Go to https://cloud.near.ai, sign in with that same NEAR wallet, and check the credit shows on the
   dashboard. If it doesn't, tell me what you see.
3. Create an API key in the dashboard and copy it.

**If the credit shows $0.00:** this happened to us, on both a wallet and a Google sign-in. Ask in the
[NEAR builders chat](https://t.me/nearbuilderschat), or buy a little under **Add credits**. Wallet accounts can
only pay with crypto, and a card needs a Google or GitHub account. Create the key on whichever account has the
credit. At the listed prices, one check costs about $0.0002, so a small amount goes a long way.

You paste it in Step 4.

## Step 2: Agent Connect key (needed)

This is the service that holds the agent's money under rules you sign.

1. Go to https://partners.near-intents.org/ and sign up or sign in. It takes you to a sign-in page at
   `signin.near-intents.org`, which is expected.
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

You should see `OK` on five lines and `All set for Phase 1.` The owner line will say "not on-chain yet",
which is normal. If the `Wardy Agent keys` line says `MISSING`, run `npm run setup:keys` again: it only fills
what's empty, so it's safe. This check only reads; it moves no money. If a line says `MISSING` or `FAILED`, send me that
line. It never prints your keys, so it's safe to share.

## Step 5: Your payout account (needed before submitting, not now)

The prize is paid to a NEAR mainnet account that you own, such as `yourname.near`, from any NEAR wallet. Use
your normal wallet, not the project accounts above. It only goes in the submission form, never in the repo.
I can't create or choose this for you.

## Step 6: The real-money check (only after I say so)

**Wait until I've seen `setup:check` and `hello:ai` pass.** These steps use real NEAR. I can't run them for you,
but I'm here for each one. Each step that signs or spends tells you exactly what it will do and waits for you
to type `yes`. Limits are built in: the script funds at most 2 NEAR at a time and pays at most 0.1 per test.
Run them in this order and send me the output of each. They never print your keys.

**1. Give the owner account a little NEAR.** From your normal wallet, send **0.5 NEAR** to the owner account
(the long name `npm run setup:keys` printed, also in `.env` as `AGENT_OWNER_ACCOUNT_ID`). Then run this, and
the owner line should show `holds 0.5000 NEAR`:

```bash
npm run setup:check
```

**2. Create the agent.** You sign its rules once. You should see `Agent created and saved to .env`.

```bash
npm run hello:custody -- create-agent
```

**3. Issue the spend grant.** This is the permission only Wardy Agent will hold. You should see `Grant issued`.

```bash
npm run hello:custody -- issue-grant
```

**4. Fund the agent.** It moves 0.2 NEAR from the owner account into the agent, plus about 0.003 NEAR in fees, and
may take a few minutes. You should see a balance for `nep141:wrap.near`. If it says the amount is below a minimum,
stop and tell me.

```bash
npm run hello:custody -- fund 0.2
```

**5. Make one real payment.** It sends 0.01 wNEAR to our own test merchant, so the money stays yours. You should
see `Status: SUCCESS`. If it says anything else, **don't run it again**; send me the output.

```bash
npm run hello:custody -- pay 0.01
```

**6. Prove native NEAR is locked.** It asks for a tiny native transfer that must be refused. You should see `PASS`.

```bash
npm run hello:custody -- native-test
```

**7. Prove freeze works.** It freezes the agent, tries a payment, then unfreezes. You should see `PASS`.

```bash
npm run hello:custody -- freeze-test
```

**8. Pay through Wardy Agent.** This is the real product: it checks first, and only then pays. It spends at most 0.015 wNEAR, to our own test merchant. Type `yes` to start. The first payment should be `HOLD`, because this payee is new, so type `approve`. Then type `yes` for the second, which should be `ALLOW` and pay with no human. You should see `Done.` If it says anything about not running it again, don't; send me the output.

```bash
npm run live:pay
```

**9. Take money back out.** It signs a policy change that allows withdrawals, which aren't limited to one destination, so step 10 turns them off again. It then shows the fee and asks you a second time before returning wNEAR from the agent to the owner account as native NEAR. Check the balance `status` shows first. You should see `Status: SUCCESS`. Use a small amount for a test, or whatever is left at the very end.

```bash
npm run hello:custody -- withdraw-back 0.05
```

**10. Lock withdrawals again.** Always run this after step 9. No money moves. The service waits a few minutes between policy changes, so if it gives you a time, run it again after that. You should see `PASS: the agent is allowed: transfer`.

```bash
npm run hello:custody -- lock-withdrawals
```

## Things you'll do later (I'll tell you when)

| When | What | Why it has to be you |
|---|---|---|
| Phase 3 | Run one command for a real ALLOW payment | Real money. I write the script and tell you what you should see |
| Phase 7, optional | Sign up at https://market.near.ai and create the listing | Website account, confirmed email |
| Phase 7, optional | Create a Telegram bot with @BotFather | Your Telegram account |
| Nov 14 | Record the video, post on X, confirm the submission | Only you can post or confirm |

## Testnet (nothing to do)

Done. I created the free testnet accounts and deployed the registry contract there. See it at
https://testnet.near.rocks/account/wardy-agent-registry.testnet.

## See the dashboard (no setup)

This works at any time, with no keys:

```bash
npm run dev
```

Open http://localhost:5173. You'll see the dashboard, labelled **Demo data**. Press **Play demo traffic** to watch it work.

To try the approval page on your real phone, make sure the phone is on the same Wi-Fi, then run:

```bash
npm run dev -- --lan
```

Open the **Dashboard** link it prints on your phone. Stop it with Control + C when you're done, because anyone on your Wi-Fi can open it while it runs.
