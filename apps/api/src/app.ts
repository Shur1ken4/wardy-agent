// The HTTP API. Four rules shape it. An agent can ask to pay but can't approve its own HOLD, because the one-time
// token never appears in anything an agent can read. Only the owner's credential can freeze or unfreeze. The owner's
// payment history, limits and earnings need that credential too: the Wardy Network is the only public data. Errors
// never repeat what was sent, so untrusted text can't leak back out through them.
import { createHash, timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { type NetworkSource, type PaymentService, RequestIdConflictError, ServiceError, type Verdict, type VerdictView } from "@wardy-agent/core";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { z, ZodError } from "zod";
import { LLMS_TXT } from "./llms.js";

export interface Earnings {
  checksSold: number;
  revenue: { currency: string; amount: string }[];
}

/** What the owner can do to the Wardy Network, signed with this instance's key. */
export interface Reporting {
  /** Publishes a report the owner confirmed. Throws a ServiceError saying why, if it can't. */
  report(verdict: Verdict): Promise<string>;
  /** Withdraws one of this instance's reports. False if it isn't one, or it's already withdrawn. */
  revoke(reportId: string): Promise<boolean>;
}

/** Offline only, so a visitor can see it work with no agent attached. All of it runs on mock ledgers. */
export interface DemoTools {
  /** Sends real requests through this API, with verdicts arriving on the live feed. */
  playTraffic(): Promise<void>;
  /** Runs the Attack Lab on its own mock ledgers, reporting each scenario as it finishes. */
  runLab(send: (event: string, data: unknown) => void): Promise<void>;
  /** A verdict from the last Attack Lab run, which never touches this instance's ledger. */
  labVerdict(verdictId: string): VerdictView | undefined;
}

/** One owner's Wardy Agent: their service, and what goes with it. A single-owner instance has just one. */
export interface Tenant {
  /** Stable and public. It goes in approval links, so a link reaches the right owner. */
  key: string;
  service: PaymentService;
  reporting?: Reporting;
  demo?: DemoTools;
  earnings?(): Earnings;
  /** What /health calls this tenant's mode, if not the instance's. */
  mode?: string;
  /** Why this tenant won't take a payee, if it won't, such as a mainnet name on a testnet-only server. */
  acceptPayee?(payee: unknown): string | undefined;
}

/** Which owner a credential belongs to. Each lookup is by credential, so one owner's token never opens another's data. */
export interface Tenancy {
  forOwner(token: string): Tenant | undefined;
  forAgent(token: string): Tenant | undefined;
  byKey(key: string): Tenant | undefined;
  /** Answers what comes with no credential: public checks, signature checks and health. */
  fallback(): Tenant;
}

export interface AppOptions {
  service: PaymentService;
  network: NetworkSource;
  /** Lets a worker agent ask to pay. It isn't a spend grant, and it can't approve anything. */
  agentToken: string;
  /** Lets the owner freeze, unfreeze and see what's waiting. */
  ownerToken: string;
  mode: string;
  /** Many owners on one instance. Without it, the service and tokens above are the only owner. */
  tenancy?: Tenancy;
  /** Extra routes on the same instance, such as sign-in on a hosted one. */
  extend?(app: FastifyInstance): void | Promise<void>;
  /**
   * Behind a hosting proxy, so rate limits count each visitor, not the proxy. A number trusts only that many proxies in
   * front: `true` would trust whatever X-Forwarded-For a visitor sends, and so let them pick their own address.
   */
  trustProxy?: boolean | number;
  /** How many live feeds one owner may hold open at once. Each is a connection the server keeps. */
  maxStreamsPerOwner?: number;
  /** The dashboard, for a browser that opens `/`. An agent asking for `/` still gets the JSON. */
  indexHtml?(): string;
  corsOrigins?: string[];
  checkRateLimitPerMinute?: number;
  payRateLimitPerMinute?: number;
  networkRateLimitPerMinute?: number;
  logger?: boolean | object;
  earnings?(): Earnings;
  reporting?: Reporting;
  demo?: DemoTools;
}

const VerdictIdParams = z.object({ id: z.uuid() });
const LimitQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const PayeeParams = z.object({ chain: z.string().min(1).max(32), payee: z.string().min(1).max(128) });
const TenantKey = z.string().min(1).max(128).optional();
const ApproveBody = z.strictObject({ action: z.enum(["approve", "reject"]), ownerToken: z.string().min(1).max(256), tenant: TenantKey });
const PreviewBody = z.strictObject({ ownerToken: z.string().min(1).max(256), tenant: TenantKey });
const ReportIdParams = z.object({ id: z.string().min(1).max(128) });
const AuditQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), verdictId: z.uuid().optional() });

function sameSecret(a: string, b: string): boolean {
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(a), hash(b));
}

function bearer(request: FastifyRequest): string {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

const unauthorized = () => new ServiceError(401, "unauthorized", "Missing or wrong credential.");

/** The one owner of a single-owner instance, as a tenancy, so both kinds run the same routes. */
export function singleTenancy(options: Pick<AppOptions, "service" | "agentToken" | "ownerToken" | "reporting" | "demo" | "earnings">): Tenancy {
  const tenant: Tenant = {
    key: "default",
    service: options.service,
    ...(options.reporting ? { reporting: options.reporting } : {}),
    ...(options.demo ? { demo: options.demo } : {}),
    ...(options.earnings ? { earnings: options.earnings } : {}),
  };
  return {
    forOwner: (token) => (sameSecret(token, options.ownerToken) ? tenant : undefined),
    forAgent: (token) => (sameSecret(token, options.agentToken) ? tenant : undefined),
    byKey: (key) => (key === tenant.key ? tenant : undefined),
    fallback: () => tenant,
  };
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { network } = options;
  const tenancy = options.tenancy ?? singleTenancy(options);
  const ownerOf = (request: FastifyRequest): Tenant => {
    const tenant = tenancy.forOwner(bearer(request));
    if (!tenant) throw unauthorized();
    return tenant;
  };
  const agentOf = (request: FastifyRequest): Tenant => {
    const tenant = tenancy.forAgent(bearer(request));
    if (!tenant) throw unauthorized();
    return tenant;
  };
  /** The owner's or their agent's: either may ask about what that agent asked for. */
  const credentialed = (request: FastifyRequest): Tenant | undefined => tenancy.forOwner(bearer(request)) ?? tenancy.forAgent(bearer(request));
  const corsOrigins = options.corsOrigins ?? ["http://localhost:5173", "http://127.0.0.1:5173"];
  const serverOptions: FastifyServerOptions = {
    logger: (options.logger ?? false) as boolean | FastifyBaseLogger,
    bodyLimit: 256 * 1024,
    forceCloseConnections: true,
    // Fastify takes a number here too, but its types don't say so. This is what it does with one: trust that many hops.
    trustProxy: typeof options.trustProxy === "number" ? ((hops: number) => (_address: string, hop: number) => hop < hops)(options.trustProxy) : (options.trustProxy ?? false),
  };
  const app = Fastify(serverOptions);

  await app.register(cors, { origin: corsOrigins });
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    if (error instanceof ZodError) {
      // An unknown field's name is text the sender chose, so it isn't repeated back: a tool that shows errors to an
      // agent must never carry a field name that reads as an instruction.
      const issues = error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.code === "unrecognized_keys" ? "has a field that isn't part of the request. Send only the fields in the request format." : issue.message,
      }));
      // Says what to fix, so an agent can correct its own call. These are the schema's words, not what was sent.
      const message = issues.map(({ path, message: why }) => (path ? `${path}: ${why}` : why)).join("; ");
      return reply.status(400).send({ error: "invalid_request", message, issues });
    }
    if (error instanceof ServiceError) return reply.status(error.status).send({ error: error.code, message: error.message });
    if (error instanceof RequestIdConflictError) return reply.status(409).send({ error: "request_id_conflict", message: error.message });
    if (error.statusCode === 429) return reply.status(429).send({ error: "rate_limited", message: "Too many requests. Wait a minute, then try again." });
    // Fastify's own refusals: oversized body, wrong content type, bad JSON.
    if (error.statusCode && error.statusCode < 500) {
      return reply.status(error.statusCode).send({ error: error.code ?? "bad_request", message: "The request was refused." });
    }
    request.log.error({ errorName: error.name }, "request failed");
    return reply.status(500).send({ error: "internal_error", message: "Something went wrong." });
  });

  // For an agent that's been given only this address. A browser on a hosted instance gets the dashboard instead.
  app.get("/", async (request, reply) => {
    if (options.indexHtml && request.headers.accept?.includes("text/html")) return reply.type("text/html; charset=utf-8").send(options.indexHtml());
    return {
      name: "Wardy Agent",
      about: "A payment firewall for AI agents on NEAR. It checks every payment, and holds the only spend grant.",
      forAgents: "/llms.txt",
      health: "/health",
      mode: options.mode,
    };
  });

  app.get("/llms.txt", async (_request, reply) => reply.type("text/plain; charset=utf-8").send(LLMS_TXT));

  app.get("/health", async (request) => {
    const tenant = credentialed(request) ?? tenancy.fallback();
    return {
      status: "ok",
      mode: tenant.mode ?? options.mode,
      provider: tenant.service.providerName,
      frozen: tenant.service.isFrozen(),
      demoTools: Boolean(tenant.demo),
      ...(options.tenancy ? { hosted: true } : {}),
    };
  });

  const payeeAllowed = (tenant: Tenant, body: unknown) => {
    const problem = tenant.acceptPayee?.((body as { payee?: unknown } | null)?.payee);
    if (problem) throw new ServiceError(400, "payee_not_allowed", problem);
  };

  // Counted per agent, not per address: the demo's own agents all call from this machine, and must not share one limit.
  const perAgent = { max: options.payRateLimitPerMinute ?? 120, timeWindow: "1 minute", keyGenerator: (request: FastifyRequest) => `pay:${createHash("sha256").update(bearer(request)).digest("hex")}` };
  app.post("/v1/pay", { config: { rateLimit: perAgent } }, async (request) => {
    const tenant = agentOf(request);
    payeeAllowed(tenant, request.body);
    return tenant.service.view(await tenant.service.pay(request.body));
  });

  // The agent's way to learn the outcome of its own request, such as what the owner decided. It says nothing else.
  app.get("/v1/pay/:id/status", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request) => {
    const tenant = credentialed(request);
    if (!tenant) throw unauthorized();
    const status = tenant.service.paymentStatus(VerdictIdParams.parse(request.params).id);
    if (!status) throw new ServiceError(404, "not_found", "No such payment.");
    return status;
  });

  app.post(
    "/v1/check",
    { config: { rateLimit: { max: options.checkRateLimitPerMinute ?? 60, timeWindow: "1 minute" } } },
    async (request) => {
      // Anyone may ask about their own payment. Asking as an owner reads that owner's history and limits, so it needs a
      // credential: the agent's or the owner's.
      const tenant = credentialed(request);
      if (tenant) {
        payeeAllowed(tenant, request.body);
        return tenant.service.view(await tenant.service.check(request.body));
      }
      const { service } = tenancy.fallback();
      if ((request.body as { ownerId?: unknown } | null)?.ownerId === service.fleetOwnerId) throw unauthorized();
      return service.view(await service.check(request.body));
    },
  );

  app.get("/v1/verdicts", async (request) => {
    const { service } = ownerOf(request);
    const { limit } = LimitQuery.parse(request.query);
    return { verdicts: service.recentVerdicts(limit) };
  });

  const verdictOr404 = (tenant: Tenant, id: string): VerdictView => {
    const verdict = tenant.service.getVerdict(id) ?? tenant.demo?.labVerdict(id);
    if (!verdict) throw new ServiceError(404, "not_found", "No such verdict.");
    return verdict;
  };

  app.get("/v1/verdicts/:id", async (request) => verdictOr404(ownerOf(request), VerdictIdParams.parse(request.params).id));

  // Open, because checking a signature is for anyone. It says nothing about the payment. Limited, because each answer
  // is a signature check, and that costs real time.
  app.get("/v1/verdicts/:id/verify", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request) => {
    const tenant = credentialed(request) ?? tenancy.fallback();
    const verdict = verdictOr404(tenant, VerdictIdParams.parse(request.params).id);
    return { valid: await tenant.service.verify(verdict), publicKey: await tenant.service.publicKey() };
  });

  app.post("/v1/verdicts/:id/report", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request) => {
    const { service, reporting } = ownerOf(request);
    const verdict = service.getVerdict(VerdictIdParams.parse(request.params).id);
    if (!verdict) throw new ServiceError(404, "not_found", "No such verdict.");
    if (!reporting) throw new ServiceError(409, "cannot_report", "This instance can't publish reports.");
    return { reportId: await reporting.report(verdict) };
  });

  app.get("/v1/audit", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request) => {
    const { service } = ownerOf(request);
    const { limit, verdictId } = AuditQuery.parse(request.query);
    return service.auditReport(limit, verdictId);
  });

  /** The link names its owner, and the one-time token is checked against that owner's records only. */
  const linkTenant = (key: string | undefined): Tenant => {
    const tenant = key ? tenancy.byKey(key) : tenancy.fallback();
    if (!tenant) throw new ServiceError(401, "invalid_token", "That approval link isn't valid.");
    return tenant;
  };

  app.post(
    "/v1/approve/:id",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const { id } = VerdictIdParams.parse(request.params);
      const { action, ownerToken, tenant } = ApproveBody.parse(request.body);
      const { service } = linkTenant(tenant);
      return service.view(await service.decideHold(id, action, ownerToken));
    },
  );

  // POST, so the token is in the body: bodies don't end up in logs or browser history.
  app.post(
    "/v1/approve/:id/preview",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const { id } = VerdictIdParams.parse(request.params);
      const { ownerToken, tenant } = PreviewBody.parse(request.body);
      return linkTenant(tenant).service.previewHold(id, ownerToken);
    },
  );

  app.get("/v1/approvals", async (request) => ({ approvals: ownerOf(request).service.pendingHolds() }));

  app.post("/v1/approvals/:id/link", async (request) => ownerOf(request).service.renewApprovalLink(VerdictIdParams.parse(request.params).id));

  app.post("/v1/freeze", async (request) => {
    ownerOf(request).service.freeze();
    return { frozen: true };
  });

  app.post("/v1/unfreeze", async (request) => {
    ownerOf(request).service.unfreeze();
    return { frozen: false };
  });

  app.get("/v1/policy", async (request) => {
    const { service } = ownerOf(request);
    return {
      policy: service.currentPolicy(),
      provider: service.providerName,
      whoCanSpend: "Wardy Agent only",
      ownerId: service.fleetOwnerId,
    };
  });

  // Free so agents use it, but limited: each answer checks signatures.
  const networkLimit = { config: { rateLimit: { max: options.networkRateLimitPerMinute ?? 120, timeWindow: "1 minute" } } };

  app.get("/v1/network/payee/:chain/:payee", networkLimit, async (request) => {
    const { chain, payee } = PayeeParams.parse(request.params);
    return network.lookup(payee, chain);
  });

  app.get("/v1/network/reports", networkLimit, async (request) => network.feed(LimitQuery.parse(request.query).limit));

  app.post("/v1/network/reports/:id/revoke", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request) => {
    const { reporting } = ownerOf(request);
    const { id } = ReportIdParams.parse(request.params);
    if (!(await reporting?.revoke(id))) throw new ServiceError(404, "not_found", "This instance has no live report with that id.");
    return { revoked: true };
  });

  app.get("/v1/stats", async (request) => {
    const { service, earnings } = ownerOf(request);
    return { ...service.stats(), earned: earnings?.() ?? { checksSold: 0, revenue: [] } };
  });

  /** Takes over the response to send events. The caller must have checked the credential first. */
  const openEventStream = (request: FastifyRequest, reply: FastifyReply) => {
    reply.hijack();
    const raw = reply.raw;
    const origin = request.headers.origin;
    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...(origin && corsOrigins.includes(origin) ? { "access-control-allow-origin": origin } : {}),
    });
    raw.write(": connected\n\n");
    return { raw, send: (event: string, data: unknown) => raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) };
  };

  // Live feed for the dashboard. Carries verdicts only, never an approval link.
  const openStreams = new Map<string, number>();
  app.get("/v1/stream", async (request, reply) => {
    const { service, key } = ownerOf(request);
    const open = openStreams.get(key) ?? 0;
    if (open >= (options.maxStreamsPerOwner ?? 20)) throw new ServiceError(429, "too_many_streams", "Too many live feeds are open. Close a tab and try again.");
    openStreams.set(key, open + 1);
    request.raw.on("close", () => {
      const left = (openStreams.get(key) ?? 1) - 1;
      if (left > 0) openStreams.set(key, left);
      else openStreams.delete(key);
    });
    const { raw, send } = openEventStream(request, reply);
    const onVerdict = (verdict: Verdict) => send("verdict", service.view(verdict));
    const onFrozen = (frozen: boolean) => send("frozen", { frozen });
    service.on("verdict", onVerdict);
    service.on("frozen", onFrozen);
    const ping = setInterval(() => raw.write(": ping\n\n"), 25_000);
    request.raw.on("close", () => {
      clearInterval(ping);
      service.off("verdict", onVerdict);
      service.off("frozen", onFrozen);
    });
  });

  // Only where some owner has demo tools. Each owner's traffic is their own, so one can't block another's.
  if (options.demo || options.tenancy) {
    const trafficRunning = new Set<string>();
    const demoOf = (request: FastifyRequest): { key: string; demo: DemoTools } => {
      const { key, demo } = ownerOf(request);
      if (!demo) throw new ServiceError(404, "not_found", "There are no demo tools here.");
      return { key, demo };
    };

    app.post("/v1/demo/traffic", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
      const { key, demo } = demoOf(request);
      if (trafficRunning.has(key)) throw new ServiceError(409, "already_running", "Demo traffic is already playing.");
      trafficRunning.add(key);
      demo
        .playTraffic()
        .catch((error: Error) => request.log.error({ errorName: error.name }, "demo traffic failed"))
        .finally(() => {
          trafficRunning.delete(key);
        });
      return reply.status(202).send({ started: true });
    });

    app.post("/v1/lab/run", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
      const { demo } = demoOf(request);
      const { raw, send } = openEventStream(request, reply);
      try {
        await demo.runLab(send);
      } catch (error) {
        request.log.error({ errorName: (error as Error).name }, "attack lab failed");
        send("error", { message: "The Attack Lab couldn't finish." });
      }
      raw.end();
    });
  }

  await options.extend?.(app);
  return app;
}
