// The HTTP API. Four rules shape it. An agent can ask to pay but can't approve its own HOLD, because the one-time
// token never appears in anything an agent can read. Only the owner's credential can freeze or unfreeze. The owner's
// payment history, limits and earnings need that credential too: the Wardy Network is the only public data. Errors
// never repeat what was sent, so untrusted text can't leak back out through them.
import { createHash, timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { type NetworkSource, type PaymentService, RequestIdConflictError, ServiceError, type Verdict, type VerdictView } from "@wardy-agent/core";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
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

export interface AppOptions {
  service: PaymentService;
  network: NetworkSource;
  /** Lets a worker agent ask to pay. It isn't a spend grant, and it can't approve anything. */
  agentToken: string;
  /** Lets the owner freeze, unfreeze and see what's waiting. */
  ownerToken: string;
  mode: string;
  corsOrigins?: string[];
  checkRateLimitPerMinute?: number;
  networkRateLimitPerMinute?: number;
  logger?: boolean | object;
  earnings?(): Earnings;
  reporting?: Reporting;
  demo?: DemoTools;
}

const VerdictIdParams = z.object({ id: z.uuid() });
const LimitQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const PayeeParams = z.object({ chain: z.string().min(1).max(32), payee: z.string().min(1).max(128) });
const ApproveBody = z.strictObject({ action: z.enum(["approve", "reject"]), ownerToken: z.string().min(1).max(256) });
const PreviewBody = z.strictObject({ ownerToken: z.string().min(1).max(256) });
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

function requireToken(request: FastifyRequest, expected: string) {
  if (!sameSecret(bearer(request), expected)) {
    throw new ServiceError(401, "unauthorized", "Missing or wrong credential.");
  }
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { service, network } = options;
  const corsOrigins = options.corsOrigins ?? ["http://localhost:5173", "http://127.0.0.1:5173"];
  const app = Fastify({
    logger: (options.logger ?? false) as boolean | FastifyBaseLogger,
    bodyLimit: 256 * 1024,
    forceCloseConnections: true,
  });

  await app.register(cors, { origin: corsOrigins });
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    if (error instanceof ZodError) {
      const issues = error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
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

  // For an agent that's been given only this address.
  app.get("/", async () => ({
    name: "Wardy Agent",
    about: "A payment firewall for AI agents on NEAR. It checks every payment, and holds the only spend grant.",
    forAgents: "/llms.txt",
    health: "/health",
    mode: options.mode,
  }));

  app.get("/llms.txt", async (_request, reply) => reply.type("text/plain; charset=utf-8").send(LLMS_TXT));

  app.get("/health", async () => ({
    status: "ok",
    mode: options.mode,
    provider: service.providerName,
    frozen: service.isFrozen(),
    demoTools: Boolean(options.demo),
  }));

  app.post("/v1/pay", async (request) => {
    requireToken(request, options.agentToken);
    return service.view(await service.pay(request.body));
  });

  // The agent's way to learn the outcome of its own request, such as what the owner decided. It says nothing else.
  app.get("/v1/pay/:id/status", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request) => {
    const token = bearer(request);
    if (!sameSecret(token, options.agentToken) && !sameSecret(token, options.ownerToken)) {
      throw new ServiceError(401, "unauthorized", "Missing or wrong credential.");
    }
    const status = service.paymentStatus(VerdictIdParams.parse(request.params).id);
    if (!status) throw new ServiceError(404, "not_found", "No such payment.");
    return status;
  });

  app.post(
    "/v1/check",
    { config: { rateLimit: { max: options.checkRateLimitPerMinute ?? 60, timeWindow: "1 minute" } } },
    async (request) => service.view(await service.check(request.body)),
  );

  app.get("/v1/verdicts", async (request) => {
    requireToken(request, options.ownerToken);
    const { limit } = LimitQuery.parse(request.query);
    return { verdicts: service.recentVerdicts(limit) };
  });

  const verdictOr404 = (id: string): VerdictView => {
    const verdict = service.getVerdict(id) ?? options.demo?.labVerdict(id);
    if (!verdict) throw new ServiceError(404, "not_found", "No such verdict.");
    return verdict;
  };

  app.get("/v1/verdicts/:id", async (request) => {
    requireToken(request, options.ownerToken);
    return verdictOr404(VerdictIdParams.parse(request.params).id);
  });

  // Open, because checking a signature is for anyone. It says nothing about the payment.
  app.get("/v1/verdicts/:id/verify", async (request) => {
    const verdict = verdictOr404(VerdictIdParams.parse(request.params).id);
    return { valid: await service.verify(verdict), publicKey: await service.publicKey() };
  });

  app.post("/v1/verdicts/:id/report", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request) => {
    requireToken(request, options.ownerToken);
    const verdict = service.getVerdict(VerdictIdParams.parse(request.params).id);
    if (!verdict) throw new ServiceError(404, "not_found", "No such verdict.");
    if (!options.reporting) throw new ServiceError(409, "cannot_report", "This instance can't publish reports.");
    return { reportId: await options.reporting.report(verdict) };
  });

  app.get("/v1/audit", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request) => {
    requireToken(request, options.ownerToken);
    const { limit, verdictId } = AuditQuery.parse(request.query);
    return service.auditReport(limit, verdictId);
  });

  app.post(
    "/v1/approve/:id",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const { id } = VerdictIdParams.parse(request.params);
      const { action, ownerToken } = ApproveBody.parse(request.body);
      return service.view(await service.decideHold(id, action, ownerToken));
    },
  );

  // POST, so the token is in the body: bodies don't end up in logs or browser history.
  app.post(
    "/v1/approve/:id/preview",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const { id } = VerdictIdParams.parse(request.params);
      return service.previewHold(id, PreviewBody.parse(request.body).ownerToken);
    },
  );

  app.get("/v1/approvals", async (request) => {
    requireToken(request, options.ownerToken);
    return { approvals: service.pendingHolds() };
  });

  app.post("/v1/approvals/:id/link", async (request) => {
    requireToken(request, options.ownerToken);
    return service.renewApprovalLink(VerdictIdParams.parse(request.params).id);
  });

  app.post("/v1/freeze", async (request) => {
    requireToken(request, options.ownerToken);
    service.freeze();
    return { frozen: true };
  });

  app.post("/v1/unfreeze", async (request) => {
    requireToken(request, options.ownerToken);
    service.unfreeze();
    return { frozen: false };
  });

  app.get("/v1/policy", async (request) => {
    requireToken(request, options.ownerToken);
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
    requireToken(request, options.ownerToken);
    const { id } = ReportIdParams.parse(request.params);
    if (!(await options.reporting?.revoke(id))) throw new ServiceError(404, "not_found", "This instance has no live report with that id.");
    return { revoked: true };
  });

  app.get("/v1/stats", async (request) => {
    requireToken(request, options.ownerToken);
    return { ...service.stats(), earned: options.earnings?.() ?? { checksSold: 0, revenue: [] } };
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
  app.get("/v1/stream", async (request, reply) => {
    requireToken(request, options.ownerToken);
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

  const { demo } = options;
  if (demo) {
    let trafficRunning = false;
    app.post("/v1/demo/traffic", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
      requireToken(request, options.ownerToken);
      if (trafficRunning) throw new ServiceError(409, "already_running", "Demo traffic is already playing.");
      trafficRunning = true;
      demo
        .playTraffic()
        .catch((error: Error) => request.log.error({ errorName: error.name }, "demo traffic failed"))
        .finally(() => {
          trafficRunning = false;
        });
      return reply.status(202).send({ started: true });
    });

    app.post("/v1/lab/run", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
      requireToken(request, options.ownerToken);
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

  return app;
}
