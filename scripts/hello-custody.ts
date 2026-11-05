// `npm run hello:custody -- <step>`: the Phase 1 custody check on NEAR Intents Agent Connect.
// THIS IS MAINNET WITH REAL MONEY. Shurik runs these steps; every step that spends or signs prints what it
// will do and waits for "yes". Amounts are capped below so a typo can't do damage. Keys are never printed.
//
//   status        read-only overview
//   create-agent  owner signs the policy once; creates the agent account
//   issue-grant   owner issues the only spend grant, saved to .env for Wardy Agent
//   fund <NEAR>   wraps NEAR from the owner account and deposits it into the agent
//   pay <wNEAR>   one real transfer to our own test merchant, then its audit proof
//   native-test   proves native NEAR transfers are refused by the policy
//   freeze-test   freezes, proves a payment is refused, unfreezes
//   withdraw-back <wNEAR>  owner allows withdrawals, then sends the agent's money back to the owner as native NEAR
//   lock-withdrawals  owner puts the transfer-only policy back
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  AgentApi,
  AgentApiError,
  createGrantCredential,
  createIdempotencyKey,
  type IntentType,
  type Policy,
  verifyOperationProof,
} from "@near-intents-agent-api/sdk";
import {
  Account,
  actions,
  encodeSignedDelegate,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  type KeyPairString,
} from "near-api-js";
import { toAtomic } from "@wardy-agent/providers";
import { fillEnv } from "./setup-keys.js";

const WNEAR = "nep141:wrap.near";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const ONE_NEAR = 10n ** 24n;
const ONE_USDC = 10n ** 6n;
const MAX_FUND = 2n * ONE_NEAR;
const MAX_PAY = ONE_NEAR / 10n;
const TGAS_30 = 30_000_000_000_000n;
const STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR, the wrap.near registration fee.
const AGENT_CREATE_KEY_FILE = ".data/agent-create-key.txt";

// The owner signs this once. Destinations stay open because worker agents choose their own payees: Wardy
// Agent checks the payee, the provider enforces everything below. `native` is left out on purpose, which
// turns native NEAR transfers off: the docs say destinations, budget and approval don't apply to them.
const POLICY: Policy = {
  frozen: false,
  actions: ["transfer"],
  confidential: false,
  owner_approval: false,
  assets: [WNEAR, USDC],
  limits: {
    per_transaction: { [WNEAR]: ONE_NEAR.toString(), [USDC]: (5n * ONE_USDC).toString() },
    daily: { [WNEAR]: (3n * ONE_NEAR).toString(), [USDC]: (15n * ONE_USDC).toString() },
  },
  max_actions_per_hour: 30,
  destinations: { mode: "any", list: [] },
  budget: { daily_usd: "20", weekly_usd: null, monthly_usd: null },
  timelock_ms: 0,
};

if (existsSync(".env")) process.loadEnvFile(".env");

function env(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is empty. ${hint}`);
  return value;
}

function saveToEnv(values: Record<string, string>) {
  writeFileSync(".env", fillEnv(readFileSync(".env", "utf8"), values), { mode: 0o600 });
}

async function confirm(summary: string, stopped = "Stopped. Nothing was done.") {
  console.log(`\n${summary}`);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question('Type "yes" to continue: ');
  prompt.close();
  if (answer.trim().toLowerCase() !== "yes") {
    console.log(stopped);
    process.exit(0);
  }
}

function apiUrl() {
  return process.env.NEAR_INTENTS_AGENT_API_URL || "https://api.agentsonintents.com";
}

function api() {
  return new AgentApi({
    baseUrl: apiUrl(),
    apiKey: env("NEAR_INTENTS_AGENT_API_KEY", "See Step 2 of docs/SETUP_FOR_SHURIK.md."),
  });
}

function owner() {
  const accountId = env("AGENT_OWNER_ACCOUNT_ID", "Run npm run setup:keys first.");
  const privateKey = env("AGENT_OWNER_PRIVATE_KEY", "Run npm run setup:keys first.") as KeyPairString;
  const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL || "https://free.rpc.fastnear.com" });
  return {
    accountId,
    publicKey: KeyPair.fromString(privateKey).getPublicKey().toString(),
    signer: KeyPairSigner.fromSecretKey(privateKey),
    account: new Account(accountId, provider, privateKey),
  };
}

type Owner = ReturnType<typeof owner>;

function agentId() {
  return env("WARDY_AGENT_ID", "Run the create-agent step first.");
}

function grantedApi() {
  return api().forGrant(env("WARDY_GRANT_TOKEN", "Run the issue-grant step first."));
}

function merchant() {
  return env("DEMO_MERCHANT_ACCOUNT_ID", "Run npm run setup:keys first.");
}

/** Signs the payload the API generated, exactly as returned, with the owner's key. */
async function signIntent(generated: any, who: Owner): Promise<any> {
  const { intent, signer } = generated;
  if (signer.type !== "near" || signer.public_key !== who.publicKey) {
    throw new Error("The API asked a different key to sign. Stopping.");
  }
  if (intent.standard === "nep413") {
    const signed = await who.signer.signNep413Message(who.accountId, {
      ...intent.payload,
      nonce: Buffer.from(intent.payload.nonce, "base64"),
    });
    return {
      ...intent,
      public_key: signer.public_key,
      signature: Buffer.from(signed.signature).toString("base64"),
    };
  }
  if (intent.standard === "nep366") {
    const { signedDelegate } = await who.account.createSignedMetaTransaction({
      receiverId: intent.payload.receiverId,
      actions: intent.payload.actions.map(({ params }: any) =>
        actions.functionCall(params.methodName, params.args, BigInt(params.gas), BigInt(params.deposit)),
      ),
      blockHeightTtl: 120,
    });
    return { ...intent, signed_delegate: Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64") };
  }
  throw new Error(`Unexpected signing standard: ${intent.standard}`);
}

/** Polls until the operation stops moving. Never resubmits: an uncertain payment could otherwise run twice. */
async function waitForStatus(client: AgentApi, correlationId: string) {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const status = await client.getStatus(correlationId, { waitMs: 30_000 });
    if (status.status !== "PROCESSING" && status.status !== "QUEUED") return status;
  }
  throw new Error(`Still processing after 5 minutes. Check ${correlationId} with the status step; do not retry.`);
}

async function runOwnerIntent(client: AgentApi, who: Owner, request: any, idempotencyKey: string = crypto.randomUUID()) {
  const generated: any = await client.generateIntent(request, { idempotencyKey });
  await client.submitIntent({
    type: generated.type as IntentType,
    correlation_id: generated.correlation_id,
    signed_data: await signIntent(generated, who),
  });
  const status: any = await waitForStatus(client, generated.correlation_id);
  if (status.status !== "SUCCESS") throw new Error(`${request.type}: ${status.status} ${status.failure_code ?? ""}`);
  return status;
}

async function printBalances(client: AgentApi, id: string) {
  const { balances } = await client.getBalances(id);
  if (balances.length === 0) console.log("Balances:   empty");
  for (const entry of balances) console.log(`Balance:    ${entry.balance ?? entry.balance_raw} ${entry.asset_id}`);
}

const steps: Record<string, (args: string[]) => Promise<void>> = {
  async status() {
    const client = api();
    const network = await client.getNetwork();
    console.log(`API:        ${apiUrl()} (${network.network})`);
    console.log(`Service:    ${network.status.overall}`);
    await client.whoami();
    console.log("API key:    accepted");
    const id = process.env.WARDY_AGENT_ID;
    if (!id) {
      console.log("Agent:      not created yet");
      return;
    }
    const agent = await client.getAgent(id);
    const policy = await client.getPolicy(id);
    console.log(`Agent:      ${agent.id} (${agent.status})`);
    console.log(`Policy:     revision ${policy.revision}, ${policy.status}, synced: ${policy.provider_policy_synced}`);
    console.log(`Allowed:    ${(policy.policy as Policy).actions.join(", ")}`);
    console.log(`Grant:     ${process.env.WARDY_GRANT_TOKEN ? "saved in .env" : "not issued yet"}`);
    await printBalances(client, id);
  },

  async "create-agent"() {
    if (process.env.WARDY_AGENT_ID) throw new Error("WARDY_AGENT_ID is already set, so an agent exists.");
    const who = owner();
    await confirm(
      `Creates one agent account on mainnet, owned by ${who.accountId}.\n` +
        "Limits: wNEAR and USDC only, transfers only, at most 1 wNEAR or 5 USDC per payment, $20 a day.\n" +
        "Native NEAR transfers stay off. The service's sponsor pays the on-chain cost.",
    );
    // Same key on a re-run, so an interrupted onboarding resumes instead of creating a second agent.
    mkdirSync(".data", { recursive: true });
    if (!existsSync(AGENT_CREATE_KEY_FILE)) writeFileSync(AGENT_CREATE_KEY_FILE, crypto.randomUUID());
    const status = await runOwnerIntent(
      api(),
      who,
      {
        type: "agent_create",
        name: "wardy-agent-fleet",
        owner: { type: "near", account_id: who.accountId, public_key: who.publicKey },
        policy: POLICY,
      },
      readFileSync(AGENT_CREATE_KEY_FILE, "utf8").trim(),
    );
    saveToEnv({ WARDY_AGENT_ID: status.agent_id });
    console.log(`Agent created and saved to .env: ${status.agent_id}`);
    console.log("Next: npm run hello:custody -- issue-grant");
  },

  async "issue-grant"() {
    if (process.env.WARDY_GRANT_TOKEN) throw new Error("WARDY_GRANT_TOKEN is already set, so a grant exists.");
    const id = agentId();
    await confirm("Issues the one spend grant for this agent, valid for 30 days. It's saved to .env, not shown.");
    const credential = createGrantCredential();
    const status = await runOwnerIntent(api(), owner(), {
      type: "grant_issue",
      agent_id: id,
      label: "wardy-agent",
      credential: credential.commitment,
      expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    saveToEnv({ WARDY_GRANT_TOKEN: credential.token });
    console.log(`Grant issued (${status.details.grant.grant_id}). The token is in .env.`);
    console.log("Next: npm run hello:custody -- fund 0.2");
  },

  async fund([amount = ""]) {
    const atomic = toAtomic(amount, 24);
    if (atomic <= 0n || atomic > MAX_FUND) throw new Error("Fund between 0 and 2 NEAR at a time.");
    const id = agentId();
    const who = owner();
    const client = api();
    const deposit: any = await client.deposit(
      id,
      { origin_asset: WNEAR, amount: atomic.toString() },
      { idempotencyKey: createIdempotencyKey() },
    );
    const { deposit_address: address, memo, min_amount: minAmount } = deposit.details;
    if (!address) throw new Error("The service gave no deposit address, so nothing was sent.");
    await confirm(
      `Sends ${amount} NEAR from the owner account, as wNEAR, to the agent's deposit address:\n` +
        `  ${address}${memo ? ` (memo ${memo})` : ""}\nMinimum accepted: ${minAmount ?? "not stated"} (atomic units).`,
    );
    const result = await who.account.signAndSendTransaction({
      receiverId: "wrap.near",
      actions: [
        // Register the owner first: otherwise near_deposit keeps the fee out of the amount, and ft_transfer comes up short.
        actions.functionCall("storage_deposit", { account_id: who.accountId, registration_only: true }, TGAS_30, STORAGE_DEPOSIT),
        actions.functionCall("storage_deposit", { account_id: address, registration_only: true }, TGAS_30, STORAGE_DEPOSIT),
        actions.functionCall("near_deposit", {}, TGAS_30, atomic),
        actions.functionCall("ft_transfer", { receiver_id: address, amount: atomic.toString(), ...(memo ? { memo } : {}) }, TGAS_30, 1n),
      ],
    });
    console.log(`Sent: https://near.rocks/tx/${result.transaction.hash}`);
    console.log("Waiting for the deposit to be credited...");
    const status: any = await waitForStatus(client, deposit.correlation_id);
    console.log(`Deposit status: ${status.status}`);
    await printBalances(client, id);
  },

  async "withdraw-back"([amount = ""]) {
    const atomic = toAtomic(amount, 24);
    if (atomic <= 0n || atomic > MAX_FUND) throw new Error("Withdraw between 0 and 2 wNEAR at a time.");
    const id = agentId();
    const who = owner();
    const client = api();
    const request = { asset: WNEAR, amount: atomic.toString(), chain: "near", recipient: who.accountId };
    await confirm(
      "Signs a policy change that also allows withdrawals. The policy doesn't limit where they go, so lock them again after.\n" +
        `Then previews withdrawing ${amount} wNEAR from the agent to the owner account, as native NEAR:\n  ${who.accountId}\n` +
        "It shows the fee and asks you again before anything moves.",
    );
    const current = await client.getPolicy(id);
    if (!(current.policy as Policy).actions.includes("withdraw")) {
      await runOwnerIntent(client, who, {
        type: "policy_update",
        agent_id: id,
        expected_revision: current.revision,
        policy: { ...POLICY, actions: ["transfer", "withdraw"] },
      });
      console.log("Policy updated: withdrawals are allowed.");
    }
    const preview: any = await grantedApi().withdraw(id, { ...request, dry: true });
    const details = preview.details ?? preview;
    console.log(`Preview: ${JSON.stringify(details)}`);
    const unlocked = "Stopped. No money moved, but withdrawals are still allowed. Run: npm run hello:custody -- lock-withdrawals";
    if (details.quote?.would_succeed === false) {
      console.log(`The service says this would fail: ${details.quote.message ?? details.quote.reason}`);
      console.log(unlocked);
      process.exit(1);
    }
    await confirm(`Withdraws ${amount} wNEAR now, with the fee shown above.`, unlocked);
    const started: any = await grantedApi().withdraw(id, request, { idempotencyKey: createIdempotencyKey() });
    const status: any = await waitForStatus(client, started.correlation_id);
    console.log(`Operation:  ${started.correlation_id}`);
    console.log(`Status:     ${status.status} ${status.failure_code ?? ""}`);
    await printBalances(client, id);
    console.log("Next: npm run hello:custody -- lock-withdrawals");
  },

  async "lock-withdrawals"() {
    const id = agentId();
    const client = api();
    const current = await client.getPolicy(id);
    if (!(current.policy as Policy).actions.includes("withdraw")) {
      console.log("Withdrawals are already off. Nothing was done.");
      return;
    }
    await confirm("Signs a policy change that turns withdrawals off again, back to transfers only. No money moves.");
    await runOwnerIntent(client, owner(), {
      type: "policy_update",
      agent_id: id,
      expected_revision: current.revision,
      policy: POLICY,
    });
    const after = await client.getPolicy(id);
    const actionsNow = (after.policy as Policy).actions;
    console.log(`${actionsNow.includes("withdraw") ? "CHECK" : "PASS"}: the agent is allowed: ${actionsNow.join(", ")}`);
  },

  async pay([amount = ""]) {
    const atomic = toAtomic(amount, 24);
    if (atomic <= 0n || atomic > MAX_PAY) throw new Error("Pay between 0 and 0.1 wNEAR in this test.");
    const id = agentId();
    const to = merchant();
    await confirm(`Sends ${amount} wNEAR from the agent to our own test merchant:\n  ${to}`);
    const started: any = await grantedApi().transfer(
      id,
      { asset: WNEAR, amount: atomic.toString(), recipient: to },
      { idempotencyKey: createIdempotencyKey() },
    );
    const client = api();
    const status: any = await waitForStatus(client, started.correlation_id);
    console.log(`Operation:  ${started.correlation_id}`);
    console.log(`Status:     ${status.status} ${status.failure_code ?? ""}`);
    console.log(`Details:    ${JSON.stringify(status.details)}`);
    await printBalances(client, id);
    try {
      const proof = await client.getOperationProof(id, started.correlation_id);
      const verified = verifyOperationProof(proof as never, `${new URL(apiUrl()).host}/log`);
      console.log(`Audit proof: ${verified.proven.length} proven, ${verified.pending} pending, ${verified.unlogged} unlogged`);
    } catch (error) {
      console.log(`Audit proof: not available (${(error as Error).message}).`);
    }
  },

  async "native-test"() {
    const id = agentId();
    const to = merchant();
    await confirm(`Asks for a native NEAR transfer of 1 yoctoNEAR (0.000000000000000000000001 NEAR) to:\n  ${to}\nIt should be refused.`);
    try {
      await grantedApi().nativeNearTransfer(id, { to, amount: "1" }, { idempotencyKey: createIdempotencyKey() });
    } catch (error) {
      if (error instanceof AgentApiError) {
        const passed = error.code === "native_method_denied";
        console.log(`${passed ? "PASS" : "CHECK"}: refused with ${error.code} (HTTP ${error.status}, layer ${error.layer})`);
        process.exit(passed ? 0 : 1);
      }
      throw error;
    }
    console.log("FAIL: the native transfer was accepted. Tell Claude right away and stop testing.");
    process.exit(1);
  },

  async "freeze-test"() {
    const id = agentId();
    const who = owner();
    const client = api();
    const { cooldowns } = await client.getAgent(id);
    const availableAt = cooldowns.unfreeze_available_at;
    if (availableAt && Date.parse(availableAt) > Date.now()) {
      throw new Error(`Unfreezing isn't possible until ${availableAt}, so this test won't freeze now. Try after that.`);
    }
    await confirm("Freezes the agent, tries a payment of the smallest possible amount (should be refused), then unfreezes.");
    await runOwnerIntent(client, who, { type: "agent_freeze", agent_id: id });
    console.log("Frozen.");
    let refusal = "NOT REFUSED";
    try {
      await grantedApi().transfer(
        id,
        { asset: WNEAR, amount: "1", recipient: merchant() },
        { idempotencyKey: createIdempotencyKey() },
      );
    } catch (error) {
      refusal = error instanceof AgentApiError ? error.code : (error as Error).message;
    }
    console.log(`${refusal === "wallet_frozen" ? "PASS" : "CHECK"}: payment while frozen gave: ${refusal}`);
    await runOwnerIntent(client, who, { type: "agent_unfreeze", agent_id: id });
    console.log("Unfrozen. Another unfreeze won't be possible for 10 minutes.");
  },
};

async function main() {
  const [name = "", ...args] = process.argv.slice(2);
  const step = steps[name];
  if (!step) {
    console.error(`Choose a step: ${Object.keys(steps).join(", ")}`);
    process.exit(1);
  }
  try {
    await step(args);
  } catch (error) {
    if (error instanceof AgentApiError) {
      console.error(`Refused: ${error.code} (HTTP ${error.status}, layer ${error.layer}) ${error.detail ?? error.title}`);
    } else {
      console.error((error as Error).message);
    }
    process.exit(1);
  }
}

await main();
