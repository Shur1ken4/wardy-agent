// The owners on a hosted server. A visitor who hasn't signed in gets a sandbox of their own: the offline demo, on mock
// ledgers, with nothing real behind it, so one visitor's traffic, approvals or freeze never reach another's. Sandboxes
// live for a while, and there's a cap on how many exist at once, so the server can't be filled up.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SEED_FEED_FILE } from "@wardy-agent/attack-lab";
import { type Tenancy, type Tenant, wire, type Wiring } from "@wardy-agent/api";
import {
  type AccountFacts,
  type AccountFactsSource,
  type ContextAnalysis,
  type ContextAnalyzer,
  type CustodyProvider,
  type CustodyResult,
  type CustodyTransfer,
  OwnerPolicySchema,
  parseDecimal,
  parseFeed,
  ServiceError,
} from "@wardy-agent/core";
import type { WalletSignIn } from "./auth.js";
import { demoTools } from "./demo-tools.js";

type Inject = Parameters<typeof demoTools>[1];

const HOSTED_POLICY = new URL("../config/policy.hosted.json", import.meta.url);

/** Testnet names and implicit accounts only, so nothing an owner does here can name a real mainnet account. */
export function testnetPayeeProblem(payee: unknown): string | undefined {
  if (typeof payee !== "string") return undefined; // The schema says what's wrong with it.
  if (payee.endsWith(".testnet") || /^[0-9a-f]{64}$/.test(payee)) return undefined;
  return "This server works on NEAR testnet only: pay a .testnet account, or an implicit one.";
}

/**
 * What the public demo tenant on a hosted server knows about accounts. A stranger's check names a real account, and
 * "doesn't exist" would be the wrong answer about a real one, so names the demo fixtures don't cover are asked of NEAR
 * itself: testnet for `.testnet` names, mainnet for the rest. Existence only, since neither has an index we trust here.
 */
export class DemoOrChainData implements AccountFactsSource {
  constructor(
    private readonly demo: AccountFactsSource,
    private readonly demoNames: ReadonlySet<string>,
    private readonly chains: { testnet: AccountFactsSource; mainnet: AccountFactsSource },
  ) {}

  getAccountFacts(accountId: string): Promise<AccountFacts> {
    if (this.demoNames.has(accountId)) return this.demo.getAccountFacts(accountId);
    return (accountId.endsWith(".testnet") ? this.chains.testnet : this.chains.mainnet).getAccountFacts(accountId);
  }
}

/** The private AI costs real credit per call, so a server open to anyone reads only so many invoices a day. */
export class DailyCappedAnalyzer implements ContextAnalyzer {
  private day = "";
  private used = 0;

  constructor(
    private readonly inner: ContextAnalyzer,
    private readonly perDay: number,
    private readonly now: () => number = Date.now,
  ) {}

  async analyze(document: string): Promise<ContextAnalysis> {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
    // Fails like an outage, so the check carries on with the rules alone.
    if (this.used >= this.perDay) throw new Error("The private AI's daily limit on this server is used up.");
    this.used += 1;
    return this.inner.analyze(document);
  }
}

/**
 * The shared test wallet, with a limit for the whole server each day. Each owner has their own limit, but testnet
 * accounts are free to make, so many sign-ups together could otherwise empty it. Past the limit a payment fails before
 * anything is sent, and it says so.
 */
export class PoolDailyCap implements CustodyProvider {
  readonly name: string;
  private day = "";
  private spent = new Map<string, bigint>();

  constructor(
    private readonly inner: CustodyProvider,
    private readonly perDay: string,
    private readonly now: () => number = Date.now,
  ) {
    this.name = inner.name;
  }

  async transfer(request: CustodyTransfer): Promise<CustodyResult> {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.spent = new Map();
    }
    const amount = parseDecimal(request.amount);
    const before = this.spent.get(request.asset) ?? 0n;
    if (before + amount > parseDecimal(this.perDay)) return { status: "failed", provider: this.name, failureCode: "server_daily_limit" };
    // Counted before it's sent, so two at once can't both slip under the limit. Only a proven failure gives it back.
    this.spent.set(request.asset, before + amount);
    const result = await this.inner.transfer(request);
    if (result.status === "failed") this.spent.set(request.asset, (this.spent.get(request.asset) ?? amount) - amount);
    return result;
  }

  balanceNearEquivalent(): Promise<number> {
    return this.inner.balanceNearEquivalent?.() ?? Promise.resolve(0);
  }
}

export interface HostedOwners {
  signIn: WalletSignIn;
  /** Private checks one owner may have read for them in a day, so one agent can't use up the whole server's AI credit. */
  aiPerOwnerPerDay?: number;
  /** Payment requests one owner's agent may make in a day. The money limits are far smaller; this bounds the disk. */
  requestsPerOwnerPerDay?: number;
  /** One pooled testnet wallet. Each owner's own small limits keep any one of them from emptying it. */
  custody: CustodyProvider;
  /** Settings for each owner's testnet wiring, such as the shared Wardy signing key and RPC. Never a mainnet key. */
  env: Record<string, string | undefined>;
  analyzer?: ContextAnalyzer;
  maxOwners?: number;
  /** Testnet account facts. By default, NEAR testnet RPC. */
  chainData?: AccountFactsSource;
  /** What the public demo tenant knows about accounts, for strangers' checks. By default the demo fixtures only. */
  publicChainData?: AccountFactsSource;
}

export interface HostedOptions {
  /** Where sandboxes keep their files. Each gets its own folder, removed when it goes. */
  dataRoot: string;
  webUrl: string;
  maxSandboxes?: number;
  /** Sandboxes one address may hold at once. Past it, that address's oldest makes room, not someone else's. */
  maxSandboxesPerAddress?: number;
  /** Agent requests one sandbox may make in its life. It's a demo, and past this it's cleared away like an idle one. */
  maxSandboxRequests?: number;
  sandboxIdleMs?: number;
  now?: () => number;
  /** Signed-in owners, each with a real testnet agent. Without it, the server has sandboxes only. */
  owners?: HostedOwners;
}

interface OwnerRecord {
  ownerId: string;
  agentTokenHash?: string;
  signedUpAt?: string;
  agentTokenMadeAt?: string;
  /** When this owner's agent last called, to the minute. */
  agentLastSeenAt?: string;
}

/** What the dashboard shows a signed-in owner about their account. Never a token or its hash. */
export interface OwnerAccount {
  kind: "owner";
  ownerId: string;
  signedUpAt?: string;
  agent: { tokenMadeAt?: string; lastSeenAt?: string };
}

const SEEN_EVERY_MS = 60_000;

export interface SandboxCredentials {
  key: string;
  ownerToken: string;
  agentToken: string;
}

interface Sandbox {
  tenant: Tenant;
  agentToken: string;
  lastUsed: number;
  /** Who made it, so one address can't crowd everyone else out. */
  address: string;
  agentRequests: number;
}

const DEFAULT_MAX_SANDBOX_REQUESTS = 2_000;
const DEFAULT_REQUESTS_PER_OWNER_PER_DAY = 1_000;
const DEFAULT_AI_PER_OWNER_PER_DAY = 50;
const PUBLIC_TENANT_VERDICTS = 2_000;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(24).toString("hex");

export const ownerKey = (ownerId: string) => `owner-${createHash("sha256").update(ownerId).digest("hex").slice(0, 24)}`;

export class HostedTenancy implements Tenancy {
  private readonly byOwnerHash = new Map<string, Sandbox>();
  private readonly byAgentHash = new Map<string, Sandbox>();
  private readonly byTenantKey = new Map<string, Sandbox>();
  private readonly owners = new Map<string, { tenant: Tenant; record: OwnerRecord; requests: { day: string; count: number } }>();
  private readonly ownerByAgentHash = new Map<string, string>();
  private inject: Inject = async () => {
    throw new Error("The server isn't listening yet.");
  };

  private constructor(
    private readonly options: HostedOptions,
    private readonly publicTenant: Tenant,
    /** The Network everyone looks up: the demo's anchored seed reports. */
    readonly network: Wiring["network"],
  ) {}

  /** The public tenant answers checks from agents with no credential, against the demo's history only. */
  static async create(options: HostedOptions): Promise<HostedTenancy> {
    const wiring = await HostedTenancy.offlineWiring(options, "public");
    const tenancy = new HostedTenancy(options, { key: "public", service: wiring.service, mode: "offline" }, wiring.network);
    // Owners who signed in before a restart keep their agent, history and agent token.
    const root = join(options.dataRoot, "owners");
    if (options.owners && existsSync(root)) {
      for (const key of readdirSync(root)) {
        const file = join(root, key, "owner.json");
        if (existsSync(file)) await tenancy.loadOwner(JSON.parse(readFileSync(file, "utf8")) as OwnerRecord);
      }
    }
    return tenancy;
  }

  hasOwner(ownerId: string): boolean {
    return this.owners.has(ownerId);
  }

  get ownerCount(): number {
    return this.owners.size;
  }

  private async loadOwner(record: OwnerRecord): Promise<Tenant> {
    const owners = this.options.owners;
    if (!owners) throw new Error("This server has no sign-in.");
    const key = ownerKey(record.ownerId);
    const dataDir = join(this.options.dataRoot, "owners", key);
    mkdirSync(dataDir, { recursive: true });
    const wiring = await wire(
      { ...owners.env, WARDY_MODE: "testnet", WARDY_OWNER_ID: record.ownerId, WARDY_WEB_URL: this.options.webUrl },
      {
        dataDir,
        tenantKey: key,
        custody: owners.custody,
        seedHistory: false,
        policy: OwnerPolicySchema.parse(JSON.parse(readFileSync(HOSTED_POLICY, "utf8"))),
        // Each owner gets a slice of the server's daily AI reads, inside the server-wide cap.
        ...(owners.analyzer ? { analyzer: new DailyCappedAnalyzer(owners.analyzer, owners.aiPerOwnerPerDay ?? DEFAULT_AI_PER_OWNER_PER_DAY, () => this.now()) } : {}),
        ...(owners.chainData ? { chainData: owners.chainData } : {}),
      },
    );
    const tenant: Tenant = { key, service: wiring.service, reporting: wiring.reporting, mode: "testnet", acceptPayee: testnetPayeeProblem };
    this.owners.set(record.ownerId, { tenant, record, requests: { day: "", count: 0 } });
    if (record.agentTokenHash) this.ownerByAgentHash.set(record.agentTokenHash, record.ownerId);
    return tenant;
  }

  private saveOwner(record: OwnerRecord) {
    const dir = join(this.options.dataRoot, "owners", ownerKey(record.ownerId));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "owner.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  }

  /** On sign-in: the owner's agent, made the first time. There's a cap, so sign-ups can't fill the server. */
  async ensureOwner(ownerId: string): Promise<Tenant> {
    const known = this.owners.get(ownerId);
    if (known) return known.tenant;
    if (this.owners.size >= (this.options.owners?.maxOwners ?? 500)) throw new Error("This server is full right now. Try the demo instead.");
    const record: OwnerRecord = { ownerId, signedUpAt: new Date(this.now()).toISOString() };
    this.saveOwner(record);
    return this.loadOwner(record);
  }

  /** A new agent token for this owner's agents. The old one stops working. Shown once, kept only as a hash. */
  newAgentToken(ownerToken: string): string | undefined {
    const ownerId = this.options.owners?.signIn.session(ownerToken);
    const sandbox = this.byOwnerHash.get(hash(ownerToken));
    const token = newToken();
    if (ownerId) {
      const owner = this.owners.get(ownerId);
      if (!owner) return undefined;
      if (owner.record.agentTokenHash) this.ownerByAgentHash.delete(owner.record.agentTokenHash);
      const { agentLastSeenAt: _old, ...rest } = owner.record;
      owner.record = { ...rest, agentTokenHash: hash(token), agentTokenMadeAt: new Date(this.now()).toISOString() };
      this.saveOwner(owner.record);
      this.ownerByAgentHash.set(hash(token), ownerId);
      return token;
    }
    if (sandbox) {
      this.byAgentHash.delete(hash(sandbox.agentToken));
      sandbox.agentToken = token;
      this.byAgentHash.set(hash(token), sandbox);
      return token;
    }
    return undefined;
  }

  /** Who a credential is, for the dashboard: a signed-in account, or a visitor's sandbox. */
  whoIs(token: string): OwnerAccount | { kind: "sandbox" } | undefined {
    const ownerId = this.options.owners?.signIn.session(token);
    const owner = ownerId ? this.owners.get(ownerId) : undefined;
    if (owner) {
      const { record } = owner;
      const agent = {
        ...(record.agentTokenHash && record.agentTokenMadeAt ? { tokenMadeAt: record.agentTokenMadeAt } : {}),
        ...(record.agentLastSeenAt ? { lastSeenAt: record.agentLastSeenAt } : {}),
      };
      return { kind: "owner", ownerId: record.ownerId, ...(record.signedUpAt ? { signedUpAt: record.signedUpAt } : {}), agent };
    }
    return this.byOwnerHash.has(hash(token)) ? { kind: "sandbox" } : undefined;
  }

  private static async offlineWiring(options: HostedOptions, key: string): Promise<Wiring> {
    const dataDir = join(options.dataRoot, "sandboxes", key);
    mkdirSync(dataDir, { recursive: true });
    // The public tenant answers anyone's checks, so it keeps nothing on disk and only its latest verdicts in memory.
    const publicChainData = options.owners?.publicChainData;
    const publicOnly = key === "public" ? { inMemory: { maxVerdicts: PUBLIC_TENANT_VERDICTS }, ...(publicChainData ? { chainData: publicChainData } : {}) } : {};
    const wiring = await wire({ WARDY_MODE: "offline", WARDY_WEB_URL: options.webUrl }, { dataDir, tenantKey: key, ...publicOnly });
    // So the Network screen has anchored reports to show. They're labelled as seed, and only count offline.
    wiring.reports.merge(parseFeed(readFileSync(SEED_FEED_FILE, "utf8")));
    return wiring;
  }

  /** Demo traffic goes through the real API, so it needs the server's way in once it exists. */
  setInject(inject: Inject) {
    this.inject = inject;
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  async createSandbox(address = ""): Promise<SandboxCredentials> {
    this.sweep();
    const byAge = (sandboxes: Sandbox[]) => sandboxes.sort((a, b) => a.lastUsed - b.lastUsed);
    // One address past its share makes room from its own sandboxes, so it can't push everyone else's out.
    const perAddress = this.options.maxSandboxesPerAddress ?? 5;
    while (address && [...this.byTenantKey.values()].filter((sandbox) => sandbox.address === address).length >= perAddress) {
      const mine = byAge([...this.byTenantKey.values()].filter((sandbox) => sandbox.address === address))[0];
      if (!mine) break;
      this.remove(mine);
    }
    const max = this.options.maxSandboxes ?? 200;
    // Full: the one used longest ago makes room, rather than refusing a new visitor.
    while (this.byTenantKey.size >= max) {
      const oldest = byAge([...this.byTenantKey.values()])[0];
      if (!oldest) break;
      this.remove(oldest);
    }
    const key = `sandbox-${randomBytes(8).toString("hex")}`;
    const ownerToken = newToken();
    const agentToken = newToken();
    const wiring = await HostedTenancy.offlineWiring(this.options, key);
    const demo = demoTools({ ...wiring, agentToken }, (request) => this.inject(request));
    const tenant: Tenant = { key, service: wiring.service, reporting: wiring.reporting, mode: "offline", ...(demo ? { demo } : {}) };
    const sandbox: Sandbox = { tenant, agentToken, lastUsed: this.now(), address, agentRequests: 0 };
    this.byOwnerHash.set(hash(ownerToken), sandbox);
    this.byAgentHash.set(hash(agentToken), sandbox);
    this.byTenantKey.set(key, sandbox);
    return { key, ownerToken, agentToken };
  }

  get sandboxCount(): number {
    return this.byTenantKey.size;
  }

  private remove(sandbox: Sandbox) {
    for (const map of [this.byOwnerHash, this.byAgentHash]) {
      for (const [tokenHash, value] of map) if (value === sandbox) map.delete(tokenHash);
    }
    this.byTenantKey.delete(sandbox.tenant.key);
    rmSync(join(this.options.dataRoot, "sandboxes", sandbox.tenant.key), { recursive: true, force: true });
  }

  /** Sandboxes nobody has touched for a while go, with their files. */
  sweep() {
    const idle = this.options.sandboxIdleMs ?? 2 * 60 * 60_000;
    for (const sandbox of [...this.byTenantKey.values()]) {
      if (this.now() - sandbox.lastUsed > idle) this.remove(sandbox);
    }
  }

  private touch(sandbox: Sandbox | undefined): Tenant | undefined {
    if (!sandbox) return undefined;
    sandbox.lastUsed = this.now();
    return sandbox.tenant;
  }

  forOwner(token: string): Tenant | undefined {
    if (!token) return undefined;
    const ownerId = this.options.owners?.signIn.session(token);
    if (ownerId) return this.owners.get(ownerId)?.tenant;
    return this.touch(this.byOwnerHash.get(hash(token)));
  }

  forAgent(token: string): Tenant | undefined {
    if (!token) return undefined;
    const ownerId = this.ownerByAgentHash.get(hash(token));
    if (ownerId) {
      const owner = this.owners.get(ownerId);
      if (!owner) return undefined;
      this.agentSeen(owner);
      // Every request is a line on the disk, and the disk is shared. The money limits are far below this.
      const day = new Date(this.now()).toISOString().slice(0, 10);
      if (owner.requests.day !== day) owner.requests = { day, count: 0 };
      if (owner.requests.count >= (this.options.owners?.requestsPerOwnerPerDay ?? DEFAULT_REQUESTS_PER_OWNER_PER_DAY)) {
        throw new ServiceError(429, "daily_request_limit", "This agent has made all the requests it may today on this server. Try again tomorrow.");
      }
      owner.requests.count += 1;
      return owner.tenant;
    }
    const sandbox = this.byAgentHash.get(hash(token));
    if (!sandbox) return undefined;
    sandbox.agentRequests += 1;
    if (sandbox.agentRequests > (this.options.maxSandboxRequests ?? DEFAULT_MAX_SANDBOX_REQUESTS)) {
      this.remove(sandbox);
      return undefined;
    }
    return this.touch(sandbox);
  }

  /** Written at most once a minute, so a busy agent doesn't rewrite the file on every call. */
  private agentSeen(owner: { record: OwnerRecord }) {
    const last = owner.record.agentLastSeenAt ? Date.parse(owner.record.agentLastSeenAt) : 0;
    if (this.now() - last < SEEN_EVERY_MS) return;
    owner.record = { ...owner.record, agentLastSeenAt: new Date(this.now()).toISOString() };
    this.saveOwner(owner.record);
  }

  byKey(key: string): Tenant | undefined {
    if (key.startsWith("owner-")) return [...this.owners.values()].find((owner) => owner.tenant.key === key)?.tenant;
    return this.touch(this.byTenantKey.get(key));
  }

  fallback(): Tenant {
    return this.publicTenant;
  }
}
