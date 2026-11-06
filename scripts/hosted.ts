// The owners on a hosted server. A visitor who hasn't signed in gets a sandbox of their own: the offline demo, on mock
// ledgers, with nothing real behind it, so one visitor's traffic, approvals or freeze never reach another's. Sandboxes
// live for a while, and there's a cap on how many exist at once, so the server can't be filled up.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SEED_FEED_FILE } from "@wardy-agent/attack-lab";
import { type Tenancy, type Tenant, wire, type Wiring } from "@wardy-agent/api";
import { parseFeed } from "@wardy-agent/core";
import { demoTools } from "./demo-tools.js";

type Inject = Parameters<typeof demoTools>[1];

export interface HostedOptions {
  /** Where sandboxes keep their files. Each gets its own folder, removed when it goes. */
  dataRoot: string;
  webUrl: string;
  maxSandboxes?: number;
  sandboxIdleMs?: number;
  now?: () => number;
}

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

export class HostedTenancy implements Tenancy {
  private readonly byOwnerHash = new Map<string, Sandbox>();
  private readonly byAgentHash = new Map<string, Sandbox>();
  private readonly byTenantKey = new Map<string, Sandbox>();
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
    return new HostedTenancy(options, { key: "public", service: wiring.service, mode: "offline" }, wiring.network);
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
    return token ? this.touch(this.byOwnerHash.get(hash(token))) : undefined;
  }

  forAgent(token: string): Tenant | undefined {
    return token ? this.touch(this.byAgentHash.get(hash(token))) : undefined;
  }

  byKey(key: string): Tenant | undefined {
    return this.touch(this.byTenantKey.get(key));
  }

  fallback(): Tenant {
    return this.publicTenant;
  }
}
