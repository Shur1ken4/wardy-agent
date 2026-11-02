// What Wardy Agent remembers: requests seen, payments settled, verdicts given. An append-only JSONL file plus
// in-memory indexes, with no native dependency, so a judge's install can't fail on a compiler.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isEvmChain } from "./accounts.js";
import type { Chain, Verdict } from "./types.js";

export interface RequestRecord {
  requestId: string;
  ownerId: string;
  agentId: string;
  payee: string;
  chain: Chain;
  createdAt: string;
}

export interface SettledPayment {
  requestId: string;
  ownerId: string;
  payee: string;
  chain: Chain;
  asset: string;
  amount: string;
  invoiceId?: string;
  invoiceTextHash?: string;
  settledAt: string;
  txHash?: string;
}

export interface KnownPayee {
  accountId: string;
  chain: Chain;
  /** Successful payments by this owner. */
  paidCount: number;
}

export interface LedgerSnapshot {
  settled: SettledPayment[];
  requests: RequestRecord[];
}

type LedgerLine =
  | { kind: "request"; record: RequestRecord }
  | { kind: "settled"; payment: SettledPayment }
  | { kind: "verdict"; verdict: Verdict };

/** EVM addresses are case-insensitive, so `0xAb` and `0xaB` are one payee. */
export function samePayee(a: { payee: string; chain: Chain }, b: { payee: string; chain: Chain }): boolean {
  if (a.chain !== b.chain) return false;
  return isEvmChain(a.chain) ? a.payee.toLowerCase() === b.payee.toLowerCase() : a.payee === b.payee;
}

export class Ledger {
  private readonly requests: RequestRecord[] = [];
  private readonly settled: SettledPayment[] = [];
  private readonly verdicts = new Map<string, Verdict>();
  private readonly verdictIdByRequest = new Map<string, string>();

  constructor(private readonly path?: string) {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) this.load(path);
  }

  private load(path: string) {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    for (const [index, line] of lines.entries()) {
      let parsed: LedgerLine;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A crash mid-write leaves a torn last line. Anywhere else, the file has been damaged.
        if (index !== lines.length - 1) throw new Error(`${path} is damaged at line ${index + 1}.`);
        writeFileSync(path, lines.slice(0, -1).map((good) => `${good}\n`).join(""));
        return;
      }
      this.apply(parsed);
    }
  }

  private apply(line: LedgerLine) {
    if (line.kind === "request") this.requests.push(line.record);
    else if (line.kind === "settled") this.settled.push(line.payment);
    else {
      this.verdicts.set(line.verdict.verdictId, line.verdict);
      this.verdictIdByRequest.set(line.verdict.requestId, line.verdict.verdictId);
    }
  }

  private write(line: LedgerLine) {
    if (this.path) appendFileSync(this.path, `${JSON.stringify(line)}\n`);
    this.apply(line);
  }

  recordRequest(record: RequestRecord) {
    this.write({ kind: "request", record });
  }

  recordSettled(payment: SettledPayment) {
    this.write({ kind: "settled", payment });
  }

  /** Saves a verdict, or a newer version of one: the latest version wins, including after a restart. */
  saveVerdict(verdict: Verdict) {
    this.write({ kind: "verdict", verdict });
  }

  verdictById(verdictId: string): Verdict | undefined {
    return this.verdicts.get(verdictId);
  }

  verdictByRequest(requestId: string): Verdict | undefined {
    const verdictId = this.verdictIdByRequest.get(requestId);
    return verdictId ? this.verdicts.get(verdictId) : undefined;
  }

  /** Most recent first. */
  recentVerdicts(limit = 50): Verdict[] {
    return [...this.verdicts.values()].reverse().slice(0, limit);
  }

  requestRecord(requestId: string): RequestRecord | undefined {
    return this.requests.find((record) => record.requestId === requestId);
  }

  snapshot(ownerId: string): LedgerSnapshot {
    return {
      settled: this.settled.filter((payment) => payment.ownerId === ownerId),
      requests: this.requests.filter((record) => record.ownerId === ownerId),
    };
  }

  knownPayees(ownerId: string): KnownPayee[] {
    const known: KnownPayee[] = [];
    for (const payment of this.settled) {
      if (payment.ownerId !== ownerId) continue;
      const entry = known.find((candidate) =>
        samePayee({ payee: candidate.accountId, chain: candidate.chain }, payment),
      );
      if (entry) entry.paidCount += 1;
      else known.push({ accountId: payment.payee, chain: payment.chain, paidCount: 1 });
    }
    return known;
  }
}
