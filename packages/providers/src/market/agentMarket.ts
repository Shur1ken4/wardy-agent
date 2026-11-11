// The NEAR AI Agent Market, where people and agents hire Wardy Agent by the job. Endpoints and fields were read from
// https://market.near.ai/openapi.json and https://docs.market.near.ai/list-your-agent on 2026-11-11. The token is bound
// to one agent and can only read its own assignments, start them, message, and submit: it can't move money.
import { z } from "zod";

export interface AgentMarketOptions {
  /** Starts with aat_. Shown once by the market; lives in .env as AGENT_MARKET_TOKEN. */
  token: string;
  apiUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** Only the fields Wardy Agent uses. Anything else the market adds passes through untouched. */
const AssignmentSchema = z.looseObject({
  assignmentId: z.string().min(1),
  jobId: z.string().min(1),
  status: z.string(),
  escrowAmount: z.string(),
  escrowToken: z.string(),
  startedAt: z.string().nullish(),
  submittedAt: z.string().nullish(),
  slaDeadlineAt: z.string(),
});

const JobBriefSchema = z.looseObject({
  jobId: z.string().min(1),
  title: z.string(),
  description: z.string(),
  jobKind: z.string(),
  tags: z.array(z.string()).default([]),
});

export const AssignmentItemSchema = z.looseObject({
  assignment: AssignmentSchema,
  job: JobBriefSchema,
  latestMessage: z.looseObject({ body: z.string(), senderSide: z.string(), createdAt: z.string() }).nullish(),
});

export type AssignmentItem = z.output<typeof AssignmentItemSchema>;

export class AgentMarketError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentMarketError";
  }
}

export interface AgentMarketLike {
  myAssignments(): Promise<AssignmentItem[]>;
  start(assignmentId: string): Promise<{ startedAt: string }>;
  message(assignmentId: string, body: string): Promise<void>;
  submit(assignmentId: string, deliverableMarkdown: string): Promise<void>;
}

export class AgentMarketClient implements AgentMarketLike {
  constructor(private readonly options: AgentMarketOptions) {
    if (!options.token.startsWith("aat_")) throw new Error("The Agent Market token should start with aat_.");
  }

  private async call<T>(path: string, body?: unknown): Promise<T> {
    const { apiUrl = "https://market.near.ai", token, fetchFn = fetch, timeoutMs = 30_000 } = this.options;
    const response = await fetchFn(`${apiUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    // The market's error text is its own words, never the token or a brief.
    if (!response.ok) throw new AgentMarketError(response.status, `Agent Market answered ${response.status} on ${path}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Every assignment still in progress: fresh hires, and ones started but not yet delivered. */
  async myAssignments(): Promise<AssignmentItem[]> {
    const body = await this.call<{ assignments?: unknown[] }>("/v1/agents/me/assignments");
    const items: AssignmentItem[] = [];
    for (const row of body.assignments ?? []) {
      const parsed = AssignmentItemSchema.safeParse(row);
      if (parsed.success) items.push(parsed.data);
    }
    return items;
  }

  /** Declares the work begun. Until this, the buyer can cancel for a full refund. Idempotent on the market's side. */
  start(assignmentId: string): Promise<{ startedAt: string }> {
    return this.call(`/v1/assignments/${encodeURIComponent(assignmentId)}/start`, {});
  }

  message(assignmentId: string, body: string): Promise<void> {
    return this.call(`/v1/assignments/${encodeURIComponent(assignmentId)}/messages`, { body });
  }

  /** Delivers. Each submit is a complete version. */
  submit(assignmentId: string, deliverableMarkdown: string): Promise<void> {
    return this.call(`/v1/assignments/${encodeURIComponent(assignmentId)}/submit`, { deliverableMarkdown });
  }
}
