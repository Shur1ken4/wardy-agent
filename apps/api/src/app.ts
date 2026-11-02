// The HTTP API. Three rules shape it. An agent can ask to pay but can't approve its own HOLD, because the one-time
// token never appears in anything an agent can read. Only the owner's credential can freeze or unfreeze. Errors
// never repeat what was sent, so untrusted text can't leak back out through them.
import { createHash, timingSafeEqual } from "node:crypto";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { type NetworkReport, type PaymentService, RequestIdConflictError, ServiceError, type Verdict } from "@wardy-agent/core";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";

export interface ReportSource {
  reportsFor(payee: string, chain: string): NetworkReport[];
  recent(limit: number): NetworkReport[];
}

export interface Earnings {
  checksSold: number;
  revenue: { currency: string; amount: string }[];
}

export interface AppOptions {
  service: PaymentService;
  reports: ReportSource;
  /** Lets a worker agent ask to pay. It isn't a spend grant, and it can't approve anything. */
  agentToken: string;
  /** Lets the owner freeze, unfreeze and see what's waiting. */
  ownerToken: string;
  mode: string;
  corsOrigins?: string[];
  checkRateLimitPerMinute?: number;
  logger?: boolean | object;
  earnings?(): Earnings;
}

const VerdictIdParams = z.object({ id: z.uuid() });
const LimitQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const PayeeParams = z.object({ chain: z.string().min(1).max(32), payee: z.string().min(1).max(128) });
const ApproveBody = z.strictObject({ action: z.enum(["approve", "reject"]), ownerToken: z.string().min(1).max(256) });

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
  const { service, reports } = options;
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
      return reply.status(400).send({
        error: "invalid_request",
        issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    if (error instanceof ServiceError) return reply.status(error.status).send({ error: error.code, message: error.message });
    if (error instanceof RequestIdConflictError) return reply.status(409).send({ error: "request_id_conflict", message: error.message });
    // Fastify's own refusals: rate limit, oversized body, wrong content type, bad JSON.
    if (error.statusCode && error.statusCode < 500) {
      return reply.status(error.statusCode).send({ error: error.code ?? "bad_request", message: "The request was refused." });
    }
    request.log.error({ errorName: error.name }, "request failed");
    return reply.status(500).send({ error: "internal_error", message: "Something went wrong." });
  });

  app.get("/health", async () => ({ status: "ok", mode: options.mode, provider: service.providerName, frozen: service.isFrozen() }));

  app.post("/v1/pay", async (request) => {
    requireToken(request, options.agentToken);
    return service.view(await service.pay(request.body));
  });

  app.post(
    "/v1/check",
    { config: { rateLimit: { max: options.checkRateLimitPerMinute ?? 60, timeWindow: "1 minute" } } },
    async (request) => service.check(request.body),
  );

  app.get("/v1/verdicts", async (request) => {
    const { limit } = LimitQuery.parse(request.query);
    return { verdicts: service.recentVerdicts(limit) };
  });

  const verdictOr404 = (id: string): Verdict => {
    const verdict = service.getVerdict(id);
    if (!verdict) throw new ServiceError(404, "not_found", "No such verdict.");
    return verdict;
  };

  app.get("/v1/verdicts/:id", async (request) => verdictOr404(VerdictIdParams.parse(request.params).id));

  app.get("/v1/verdicts/:id/verify", async (request) => {
    const verdict = verdictOr404(VerdictIdParams.parse(request.params).id);
    return { valid: await service.verify(verdict), publicKey: await service.publicKey() };
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

  app.get("/v1/policy", async () => ({
    policy: service.currentPolicy(),
    provider: service.providerName,
    whoCanSpend: "Wardy Agent only",
    ownerId: service.fleetOwnerId,
  }));

  app.get("/v1/network/payee/:chain/:payee", async (request) => {
    const { chain, payee } = PayeeParams.parse(request.params);
    const found = reports.reportsFor(payee, chain);
    // Proofs and the anchored root arrive with the Wardy Network in Phase 5.
    return { reported: found.length > 0, reports: found, merkleProof: null, anchoredRoot: null, anchorTx: null };
  });

  app.get("/v1/network/reports", async (request) => {
    const { limit } = LimitQuery.parse(request.query);
    return { reports: reports.recent(limit) };
  });

  app.get("/v1/stats", async () => ({
    ...service.stats(),
    earned: options.earnings?.() ?? { checksSold: 0, revenue: [] },
  }));

  // Live feed for the dashboard. Carries verdicts only, never an approval link.
  app.get("/v1/stream", (request, reply) => {
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
    const send = (event: string, data: unknown) => raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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

  return app;
}
