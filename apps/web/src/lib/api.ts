// Talks to the Wardy Agent API, on the same origin. The owner's credential stays in this tab only, and is never put in
// a URL. Offline mode's credential is public on purpose: it's the demo's, and guards nothing real.
import type { AnchorSummary, AuditRecord, FeedEntry, OwnerPolicy, PayeeLookup, Verdict, VerdictView } from "@wardy-agent/core";
import { readEvents, type ServerEvent } from "./events";

const CREDENTIAL_KEY = "wardy-agent-owner-credential";
export const OFFLINE_OWNER_CREDENTIAL = "offline-owner-token";
/** On your own machine the API is a terminal you can check; on a hosted server it's the connection. */
const UNREACHABLE = typeof window !== "undefined" && window.location.port === "5173" ? "Can't reach the Wardy Agent API. Is npm run dev still running?" : "Can't reach Wardy Agent right now. Check your connection, then try again.";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function savedCredential(): string | null {
  try {
    return sessionStorage.getItem(CREDENTIAL_KEY);
  } catch {
    return null;
  }
}

export function saveCredential(credential: string | null) {
  try {
    if (credential) sessionStorage.setItem(CREDENTIAL_KEY, credential);
    else sessionStorage.removeItem(CREDENTIAL_KEY);
  } catch {
    // A browser that blocks storage just asks again next time.
  }
}

let credential: string | null = null;
export const setApiCredential = (value: string | null) => {
  credential = value;
};

function authHeaders(): Record<string, string> {
  return credential ? { authorization: `Bearer ${credential}` } : {};
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers: { ...authHeaders(), ...(init.headers ?? {}) } });
  } catch {
    throw new ApiError(0, "unreachable", UNREACHABLE);
  }
  const text = await response.text();
  let body: { error?: string; message?: string } = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // Not JSON means something else answered, such as a proxy with no server behind it.
    if (!response.ok) throw new ApiError(response.status, "unreachable", UNREACHABLE);
  }
  if (!response.ok) throw new ApiError(response.status, body.error ?? "error", body.message ?? "That didn't work.");
  return body as T;
}

const postJson = <T>(path: string, body: unknown) => call<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export interface Health {
  status: string;
  mode: string;
  provider: string;
  frozen: boolean;
  demoTools: boolean;
  /** On a hosted server, where each visitor gets their own sandbox. */
  hosted?: boolean;
}

export interface Stats {
  checkedToday: number;
  blockedToday: number;
  heldNow: number;
  paidToday: number;
  saved: { asset: string; amount: string }[];
  /** Settled in the last 24 hours, the window the daily budget uses. */
  spentLast24h?: { asset: string; amount: string }[];
  checksForOthers: number;
  earned: { checksSold: number; revenue: { currency: string; amount: string }[]; lastSale?: { amount: string; currency: string }; freeRuns?: number };
}

/** Who this browser is on a hosted server: a signed-in account, or a visitor's sandbox. */
export type Me =
  | { kind: "owner"; ownerId: string; signedUpAt?: string; agent: { tokenMadeAt?: string; lastSeenAt?: string }; signInAvailable: boolean }
  | { kind: "sandbox"; signInAvailable: boolean };

export interface PolicyView {
  policy: OwnerPolicy;
  provider: string;
  whoCanSpend: string;
  ownerId: string;
}

export interface AuditView {
  valid: boolean;
  entries: number;
  signaturesChecked: number;
  publicKeys: string[];
  problem?: { line: number; reason: string };
  records: AuditRecord[];
}

export interface HoldPreview {
  verdict: VerdictView;
  expiresAt: string;
  open: boolean;
}

export const api = {
  health: () => call<Health>("/health"),
  stats: () => call<Stats>("/v1/stats"),
  verdicts: (limit = 100) => call<{ verdicts: VerdictView[] }>(`/v1/verdicts?limit=${limit}`),
  verdict: (id: string) => call<VerdictView>(`/v1/verdicts/${encodeURIComponent(id)}`),
  verify: (id: string) => call<{ valid: boolean; publicKey: string }>(`/v1/verdicts/${encodeURIComponent(id)}/verify`),
  report: (id: string) => call<{ reportId: string }>(`/v1/verdicts/${encodeURIComponent(id)}/report`, { method: "POST" }),
  audit: (verdictId?: string) => call<AuditView>(`/v1/audit${verdictId ? `?verdictId=${encodeURIComponent(verdictId)}` : ""}`),
  policy: () => call<PolicyView>("/v1/policy"),
  approvals: () => call<{ approvals: { verdict: Verdict; expiresAt: string }[] }>("/v1/approvals"),
  approvalLink: (id: string) => call<{ approvalUrl: string; expiresAt: string }>(`/v1/approvals/${encodeURIComponent(id)}/link`, { method: "POST" }),
  freeze: () => call<{ frozen: boolean }>("/v1/freeze", { method: "POST" }),
  unfreeze: () => call<{ frozen: boolean }>("/v1/unfreeze", { method: "POST" }),
  lookup: (payee: string, chain = "near") => call<PayeeLookup>(`/v1/network/payee/${encodeURIComponent(chain)}/${encodeURIComponent(payee)}`),
  networkFeed: (limit = 100) => call<{ reports: FeedEntry[]; anchor: AnchorSummary | null }>(`/v1/network/reports?limit=${limit}`),
  revokeReport: (id: string) => call<{ revoked: boolean }>(`/v1/network/reports/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
  previewHold: (id: string, ownerToken: string, tenant?: string) =>
    postJson<HoldPreview>(`/v1/approve/${encodeURIComponent(id)}/preview`, { ownerToken, ...(tenant ? { tenant } : {}) }),
  decideHold: (id: string, action: "approve" | "reject", ownerToken: string, tenant?: string) =>
    postJson<VerdictView>(`/v1/approve/${encodeURIComponent(id)}`, { action, ownerToken, ...(tenant ? { tenant } : {}) }),
  /** A hosted server's own demo for this visitor. Nothing real behind it. */
  sandbox: () => call<{ key: string; ownerToken: string; agentToken: string }>("/v1/sandbox", { method: "POST" }),
  me: () => call<Me>("/v1/me"),
  signInChallenge: () => call<{ message: string; recipient: string; nonce: string }>("/v1/auth/challenge", { method: "POST" }),
  signInVerify: (body: { accountId: string; publicKey: string; signature: string; nonce: string }) => postJson<{ ownerId: string; sessionToken: string; expiresAt: string }>("/v1/auth/verify", body),
  signOut: () => call<{ signedOut: boolean }>("/v1/auth/logout", { method: "POST" }),
  /** A new token for this owner's agents. The old one stops working. */
  newAgentToken: () => call<{ agentToken: string }>("/v1/agent-token", { method: "POST" }),
  playTraffic: () => call<{ started: boolean }>("/v1/demo/traffic", { method: "POST" }),
  check: (request: Record<string, unknown>) => postJson<VerdictView>("/v1/check", request),
};

async function openStream(path: string, init: RequestInit, onEvent: (event: ServerEvent) => void, onOpen?: () => void): Promise<void> {
  const response = await fetch(path, { ...init, headers: { ...authHeaders(), ...(init.headers ?? {}) } });
  if (!response.ok) throw new ApiError(response.status, "stream_refused", "The live feed refused the connection.");
  onOpen?.();
  await readEvents(response, onEvent);
}

/** `onOpen` runs once the server has really answered, so "Live" on the screen is true. */
export const liveFeed = (onEvent: (event: ServerEvent) => void, signal: AbortSignal, onOpen: () => void) => openStream("/v1/stream", { signal }, onEvent, onOpen);
export const runAttackLab = (onEvent: (event: ServerEvent) => void, signal: AbortSignal) => openStream("/v1/lab/run", { method: "POST", signal }, onEvent);

export interface OnChainRoot {
  root: string;
  count: number;
  block_height: string;
}

/** Asks the contract itself, over a public RPC. Only runs when someone presses the button, because it leaves this machine. */
export async function readRootFromChain(contractId: string): Promise<OnChainRoot | null> {
  const response = await fetch("https://test.rpc.fastnear.com", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "wardy-agent",
      method: "query",
      params: { request_type: "call_function", finality: "final", account_id: contractId, method_name: "get_latest_root", args_base64: btoa("{}") },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json()) as { result?: { result?: number[] } };
  const bytes = body.result?.result;
  return bytes ? (JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) as OnChainRoot | null) : null;
}
