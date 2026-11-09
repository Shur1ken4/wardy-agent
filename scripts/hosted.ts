// The owners on a hosted server. A visitor who hasn't signed in gets a sandbox of their own: the offline demo, on mock
// ledgers, with nothing real behind it, so one visitor's traffic, approvals or freeze never reach another's. Sandboxes
// live for a while, and there's a cap on how many exist at once, so the server can't be filled up.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SEED_FEED_FILE } from "@wardy-agent/attack-lab";
import { type Tenancy, type Tenant, wire, type Wiring } from "@wardy-agent/api";
import {
  type AccountFactsSource,
  type ContextAnalysis,
  type ContextAnalyzer,
  type CustodyProvider,
  type CustodyResult,
  type CustodyTransfer,
  OwnerPolicySchema,
  parseDecimal,
  parseFeed,
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
  /** One pooled testnet wallet. Each owner's own small limits keep any one of them from emptying it. */
  custody: CustodyProvider;
  /** Settings for each owner's testnet wiring, such as the shared Wardy signing key and RPC. Never a mainnet key. */
  env: Record<string, string | undefined>;
  analyzer?: ContextAnalyzer;
  maxOwners?: number;
  /** Testnet account facts. By default, NEAR testnet RPC. */
  chainData?: AccountFactsSource;
}

export interface HostedOptions {
  /** Where sandboxes keep their files. Each gets its own folder, removed when it goes. */
  dataRoot: string;
  webUrl: string;
  maxSandboxes?: number;
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
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(24).toString("hex");

export const ownerKey = (ownerId: string) => `owner-${createHash("sha256").update(ownerId).digest("hex").slice(0, 24)}`;

export class HostedTenancy implements Tenancy {
  private readonly byOwnerHash = new Map<string, Sandbox>();
  private readonly byAgentHash = new Map<string, Sandbox>();
  private readonly byTenantKey = new Map<string, Sandbox>();
  private readonly owners = new Map<string, { tenant: Tenant; record: OwnerRecord }>();
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
        ...(owners.analyzer ? { analyzer: owners.analyzer } : {}),
        ...(owners.chainData ? { chainData: owners.chainData } : {}),
      },
    );
    const tenant: Tenant = { key, service: wiring.service, reporting: wiring.reporting, mode: "testnet", acceptPayee: testnetPayeeProblem };
    this.owners.set(record.ownerId, { tenant, record });
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
    const wiring = await wire({ WARDY_MODE: "offline", WARDY_WEB_URL: options.webUrl }, { dataDir, tenantKey: key });
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

  async createSandbox(): Promise<SandboxCredentials> {
    this.sweep();
    const max = this.options.maxSandboxes ?? 200;
    // Full: the one used longest ago makes room, rather than refusing a new visitor.
    while (this.byTenantKey.size >= max) {
      const oldest = [...this.byTenantKey.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!oldest) break;
      this.remove(oldest);
    }
    const key = `sandbox-${randomBytes(8).toString("hex")}`;
    const ownerToken = newToken();
    const agentToken = newToken();
    const wiring = await HostedTenancy.offlineWiring(this.options, key);
    const demo = demoTools({ ...wiring, agentToken }, (request) => this.inject(request));
    const tenant: Tenant = { key, service: wiring.service, reporting: wiring.reporting, mode: "offline", ...(demo ? { demo } : {}) };
    const sandbox: Sandbox = { tenant, agentToken, lastUsed: this.now() };
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
      if (owner) this.agentSeen(owner);
      return owner?.tenant;
    }
    return this.touch(this.byAgentHash.get(hash(token)));
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
