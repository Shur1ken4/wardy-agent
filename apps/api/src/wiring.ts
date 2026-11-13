// Picks the real or mock service behind each interface, from WARDY_MODE. Offline needs nothing and touches no
// network. Live refuses to start on anything unsafe, and says which setting is wrong without ever printing one.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuditLog,
  type ContextAnalyzer,
  createNetworkReport,
  type CustodyProvider,
  generateSigningKey,
  Ledger,
  NetworkQuery,
  OFFLINE_TEST_SIGNING_KEY,
  type OwnerPolicy,
  OwnerPolicySchema,
  PaymentService,
  publicKeyOf,
  publishIfWarranted,
  readAnchorRecord,
  type ReportRules,
  ReportStore,
  SEED_PAYEES,
  ServiceError,
  type AccountFactsSource,
  verifyReportEvidence,
  whyOwnerCantReport,
} from "@wardy-agent/core";
import {
  AgentConnectCustody,
  EarningsLog,
  MockChainData,
  MockContextAnalyzer,
  MockCustody,
  NearAiContextAnalyzer,
  NearChainData,
  OFFLINE_ACCOUNTS,
  OutLayerCustody,
  RECORDED_AI_FINDINGS,
  seedOfflineHistory,
} from "@wardy-agent/providers";

import type { Earnings, Reporting } from "./app.js";

export type Mode = "offline" | "testnet" | "live";

export const OFFLINE_AGENT_TOKEN = "offline-agent-token";
export const OFFLINE_OWNER_TOKEN = "offline-owner-token";
const DEFAULT_OWNER = "demo-owner.near";
const MAX_LIVE_BALANCE_NEAR = 10;
const POLICY_FILE = new URL("../../../config/policy.json", import.meta.url);
const OUTLAYER_WALLET_FILE = ".data/outlayer-testnet.json";
export const ANCHOR_FILE = fileURLToPath(new URL("../../../config/network-anchor.testnet.json", import.meta.url));
const OFFLINE_FUNDS = { "nep141:wrap.near": "100", "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": "100" };

export interface Wiring {
  mode: Mode;
  service: PaymentService;
  reports: ReportStore;
  network: NetworkQuery;
  reporting: Reporting;
  custody: CustodyProvider;
  agentToken: string;
  ownerToken: string;
  webUrl: string;
  dataDir: string;
  /** Hires delivered on the Agent Market, each a real job. The Earnings page shows this and nothing made up. */
  earningsLog: EarningsLog;
  earnings(): Earnings;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string, hint: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is empty, and ${hint}. See docs/SETUP_FOR_SHURIK.md.`);
  return value;
}

export function loadPolicy(): OwnerPolicy {
  return OwnerPolicySchema.parse(JSON.parse(readFileSync(POLICY_FILE, "utf8")));
}

/** Throw-away secrets for testnet, kept in the git-ignored data folder, so it needs no setup. */
function localSecrets(dataDir: string) {
  const path = join(dataDir, "secrets.json");
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as { signingKey: string; agentToken: string; ownerToken: string };
  const secrets = {
    signingKey: generateSigningKey(),
    agentToken: randomBytes(24).toString("hex"),
    ownerToken: randomBytes(24).toString("hex"),
  };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  return secrets;
}

/** Live mode refuses to start with more at stake than this project should ever hold. Fails closed. */
export async function assertBalanceIsSafe(custody: CustodyProvider, understood: boolean): Promise<void> {
  if (understood || !custody.balanceNearEquivalent) return;
  let balance: number;
  try {
    balance = await custody.balanceNearEquivalent();
  } catch (error) {
    throw new Error(`Couldn't check the custody balance, so live mode won't start: ${(error as Error).message}`);
  }
  if (balance > MAX_LIVE_BALANCE_NEAR) {
    throw new Error(
      `Custody holds about ${balance.toFixed(2)} NEAR, above the ${MAX_LIVE_BALANCE_NEAR} NEAR safety limit. ` +
        "Move funds out, or set WARDY_I_UNDERSTAND_RISK=1 if you really mean it.",
    );
  }
}

/** Real attestation when a key is set. Without one, only the deterministic checks read the text. */
function nearAi(env: Env): ContextAnalyzer | undefined {
  const apiKey = env.NEAR_AI_CLOUD_API_KEY;
  if (!apiKey) return undefined;
  return new NearAiContextAnalyzer({
    apiKey,
    model: env.NEAR_AI_MODEL || "z-ai/glm-5.3-flash",
    ...(env.NEAR_AI_CLOUD_BASE_URL ? { baseUrl: env.NEAR_AI_CLOUD_BASE_URL } : {}),
  });
}

export interface WireOverrides {
  dataDir?: string;
  custody?: CustodyProvider;
  /** Offline, the demo owner starts with a past. False gives a clean slate. */
  seedHistory?: boolean;
  anchorFile?: string;
  /** Where testnet's throw-away secrets live, if not with the data. So a fresh ledger can keep the same reporter. */
  secretsDir?: string;
  /** On an instance with many owners, approval links name this one, so the link reaches the right owner. */
  tenantKey?: string;
  /** An owner's limits, instead of config/policy.json. A hosted server gives each owner small testnet ones. */
  policy?: OwnerPolicy;
  /** One private-AI reader shared by many owners, so its daily cap counts them all. */
  analyzer?: ContextAnalyzer;
  /** Account facts from somewhere else: a test's fixed answers, or NEAR itself behind the hosted public demo. */
  chainData?: AccountFactsSource;
  /**
   * Which payees this tenant may publish a Network report about. A hosted demo looks real accounts up on NEAR, but a
   * demo must never publish a report about a real account, so there only the demo's own names can be reported.
   */
  mayReport?: (payee: string) => boolean;
  /**
   * Keep the ledger and audit log in memory, holding only this many verdicts and lines. For the public demo tenant on a
   * hosted server, which anyone can send checks to: nothing of it is anyone's money, and a file it appends to would only
   * grow. Reports still go to disk.
   */
  inMemory?: { maxVerdicts: number };
}

export async function wire(env: Env, overrides: WireOverrides = {}): Promise<Wiring> {
  const mode = (env.WARDY_MODE || "offline") as Mode;
  if (!["offline", "testnet", "live"].includes(mode)) throw new Error(`WARDY_MODE must be offline, testnet or live, not "${mode}".`);

  const dataDir = overrides.dataDir ?? env.WARDY_DATA_DIR ?? join(".data", mode);
  mkdirSync(dataDir, { recursive: true });
  const policy = overrides.policy ?? loadPolicy();

  let custody: CustodyProvider;
  let chainData: AccountFactsSource;
  let analyzer: ContextAnalyzer | undefined;
  let signingKey: string;
  let agentToken: string;
  let ownerToken: string;
  let seedPayees: readonly string[] = SEED_PAYEES;

  if (mode === "offline") {
    custody = overrides.custody ?? new MockCustody(OFFLINE_FUNDS);
    chainData = overrides.chainData ?? new MockChainData(OFFLINE_ACCOUNTS);
    analyzer = new MockContextAnalyzer(RECORDED_AI_FINDINGS);
    signingKey = OFFLINE_TEST_SIGNING_KEY;
    agentToken = OFFLINE_AGENT_TOKEN;
    ownerToken = OFFLINE_OWNER_TOKEN;
  } else if (mode === "testnet") {
    const walletFile = existsSync(OUTLAYER_WALLET_FILE) ? (JSON.parse(readFileSync(OUTLAYER_WALLET_FILE, "utf8")) as { apiKey: string }) : null;
    const apiKey = env.OUTLAYER_API_KEY || walletFile?.apiKey;
    if (!apiKey && !overrides.custody) throw new Error("No OutLayer testnet wallet yet. Run: npm run setup:testnet");
    custody = overrides.custody ?? new OutLayerCustody({ apiUrl: env.OUTLAYER_API_URL || "https://testnet-api.outlayer.ai", apiKey: apiKey as string });
    // No NearBlocks here: its testnet index is weeks behind, so its age data would be wrong.
    chainData = overrides.chainData ?? new NearChainData({ rpcUrl: env.NEAR_TESTNET_RPC_URL || "https://test.rpc.fastnear.com" });
    analyzer = overrides.analyzer ?? nearAi(env);
    const secrets = localSecrets(overrides.secretsDir ?? dataDir);
    signingKey = env.WARDY_SIGNING_KEY || secrets.signingKey;
    agentToken = env.WARDY_AGENT_TOKEN || secrets.agentToken;
    ownerToken = env.WARDY_OWNER_TOKEN || secrets.ownerToken;
    seedPayees = []; // The seed list is mainnet names; wrap.testnet isn't a lookalike of wrap.near.
  } else {
    custody =
      overrides.custody ??
      new AgentConnectCustody({
        apiUrl: env.NEAR_INTENTS_AGENT_API_URL || "https://api.agentsonintents.com",
        apiKey: required(env, "NEAR_INTENTS_AGENT_API_KEY", "live mode needs it"),
        agentId: required(env, "WARDY_AGENT_ID", "live mode needs the agent created by hello:custody"),
        grantToken: required(env, "WARDY_GRANT_TOKEN", "live mode needs the grant issued by hello:custody"),
      });
    chainData = new NearChainData({
      rpcUrl: env.NEAR_RPC_URL || "https://free.rpc.fastnear.com",
      nearblocksUrl: env.NEARBLOCKS_API_URL || "https://api.nearblocks.io",
      ...(env.NEARBLOCKS_API_KEY ? { nearblocksApiKey: env.NEARBLOCKS_API_KEY } : {}),
    });
    analyzer = nearAi(env);
    signingKey = required(env, "WARDY_SIGNING_KEY", "live mode won't use a test key");
    agentToken = required(env, "WARDY_AGENT_TOKEN", "live mode won't use a default credential");
    ownerToken = required(env, "WARDY_OWNER_TOKEN", "live mode won't use a default credential");
    await assertBalanceIsSafe(custody, env.WARDY_I_UNDERSTAND_RISK === "1");
  }

  const reports = new ReportStore(join(dataDir, "network", "reports.jsonl"));
  const ledger = overrides.inMemory ? new Ledger(undefined, { maxVerdicts: overrides.inMemory.maxVerdicts }) : new Ledger(join(dataDir, "ledger.jsonl"));
  const audit = overrides.inMemory ? new AuditLog(undefined, { keep: overrides.inMemory.maxVerdicts * 2 }) : new AuditLog(join(dataDir, "audit.jsonl"));
  // The offline demo is always the demo owner. A real account in .env would make the public demo credentials fail.
  const fleetOwnerId = env.WARDY_OWNER_ID || (mode !== "offline" && env.AGENT_OWNER_ACCOUNT_ID) || DEFAULT_OWNER;
  if (mode === "offline" && overrides.seedHistory !== false && ledger.knownPayees(fleetOwnerId).length === 0) {
    seedOfflineHistory(ledger, fleetOwnerId, new Date());
  }

  const reportRules: ReportRules = {
    trustedReporters: new Set([await publicKeyOf(signingKey)]),
    verifyEvidence: verifyReportEvidence,
    allowSeedReports: mode === "offline",
  };
  const anchorFile = overrides.anchorFile ?? ANCHOR_FILE;
  const network = new NetworkQuery(reports, reportRules, () => readAnchorRecord(anchorFile));

  const webUrl = env.WARDY_WEB_URL || "http://localhost:5173";
  const service = new PaymentService({
    ledger,
    audit,
    seedPayees,
    chainData,
    ...(analyzer ? { analyzer } : {}),
    reportsFor: (payee, chain) => reports.reportsFor(payee, chain),
    reportRules,
    onBlocked: async (verdict) =>
      overrides.mayReport && !overrides.mayReport(verdict.payee) ? undefined : publishIfWarranted(reports, verdict, { signingKey, createdAt: new Date().toISOString() }),
    signingKey,
    custody,
    fleetOwnerId,
    policy,
    // After the #, because browsers never send that part to a server, so the token stays out of every request log.
    approvalUrl: (verdictId, token) => `${webUrl}/approve/${verdictId}#token=${token}${overrides.tenantKey ? `&t=${overrides.tenantKey}` : ""}`,
  });
  const reporting: Reporting = {
    report: async (verdict) => {
      const refused = whyOwnerCantReport(verdict);
      if (refused) throw new ServiceError(409, "cannot_report", refused);
      if (overrides.mayReport && !overrides.mayReport(verdict.payee)) {
        throw new ServiceError(409, "cannot_report", "This demo reports only its own demo accounts, never a real NEAR account.");
      }
      const reporter = await publicKeyOf(signingKey);
      if (reports.reportsFor(verdict.payee, verdict.chain).some((report) => report.reporter === reporter && !report.revokedAt)) {
        throw new ServiceError(409, "already_reported", "This payee already has a live report from you.");
      }
      const report = await createNetworkReport(verdict, { signingKey, createdAt: new Date().toISOString(), ownerConfirmed: true });
      reports.add(report);
      service.markReported(verdict.verdictId, report.reportId);
      return report.reportId;
    },
    revoke: (reportId) => reports.revoke(reportId, new Date().toISOString(), signingKey),
  };
  // Sales are kept on disk even where the ledger isn't: a hire is real money, and a restart mustn't forget it.
  const earningsLog = new EarningsLog(join(dataDir, "market", "earnings.jsonl"));
  return { mode, service, reports, network, reporting, custody, agentToken, ownerToken, webUrl, dataDir, earningsLog, earnings: () => earningsLog.summary() };
}
