// Append-only JSONL. Each line is { entry, prevHash, hash }, where hash covers the entry and the line before
// it, so changing, removing or reordering a line breaks every line after it. Cutting lines off the end leaves
// a shorter valid chain; anchoring the head hash somewhere public is what would catch that.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson } from "./canonical.js";
import { sha256Hex } from "./hash.js";
import { verifyVerdict } from "./sign.js";
import type { Verdict, VerdictExecution } from "./types.js";

export type AuditEntry =
  | { type: "verdict"; at: string; verdict: Verdict }
  | { type: "execution"; at: string; verdictId: string; execution: VerdictExecution }
  | { type: "owner_action"; at: string; verdictId: string; action: "approve" | "reject" }
  | { type: "freeze" | "unfreeze"; at: string };

export interface AuditRecord {
  entry: AuditEntry;
  prevHash: string;
  hash: string;
}

export const GENESIS_HASH = "0".repeat(64);

function chainHash(entry: AuditEntry, prevHash: string): string {
  return sha256Hex(canonicalJson({ entry, prevHash }));
}

export interface AuditLogOptions {
  /**
   * In memory only: keep this many lines, oldest out first. The chain still runs through the head hash, so later lines
   * still commit to the dropped ones, but the kept lines alone no longer verify from the start. For a log anyone on the
   * internet can append to, such as the public demo's, which no owner ever audits.
   */
  keep?: number;
}

/** Writes to `path` when given; otherwise keeps lines in memory, for tests and one-shot runs. */
export class AuditLog {
  private readonly memory: string[] = [];
  private head = GENESIS_HASH;

  constructor(
    private readonly path?: string,
    private readonly options: AuditLogOptions = {},
  ) {
    if (options.keep !== undefined && path) throw new Error("A capped audit log must stay in memory: a file is never cut.");
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) return;
    const lastLine = splitLines(readFileSync(path, "utf8")).at(-1);
    if (lastLine === undefined) return;
    try {
      this.head = (JSON.parse(lastLine) as AuditRecord).hash;
    } catch {
      throw new Error(`The last line of ${path} is damaged. Run npm run verify-audit before continuing.`);
    }
  }

  append(entry: AuditEntry): AuditRecord {
    const record: AuditRecord = { entry, prevHash: this.head, hash: chainHash(entry, this.head) };
    const line = JSON.stringify(record);
    if (this.path) appendFileSync(this.path, `${line}\n`);
    else {
      this.memory.push(line);
      if (this.options.keep !== undefined && this.memory.length > this.options.keep) this.memory.splice(0, this.memory.length - this.options.keep);
    }
    this.head = record.hash;
    return record;
  }

  headHash(): string {
    return this.head;
  }

  lines(): string[] {
    return this.path ? splitLines(readFileSync(this.path, "utf8")) : [...this.memory];
  }
}

function splitLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

export interface AuditReport {
  valid: boolean;
  entries: number;
  signaturesChecked: number;
  /** Every key that signed a verdict, so a stranger's key stands out. */
  publicKeys: string[];
  problem?: { line: number; reason: string };
}

/** Recomputes the whole chain and checks every verdict signature. Stops at the first problem. */
export async function verifyAuditLines(lines: string[], expectedPublicKey?: string): Promise<AuditReport> {
  const publicKeys = new Set<string>();
  let prevHash = GENESIS_HASH;
  let signaturesChecked = 0;
  const report = (entries: number, problem?: AuditReport["problem"]): AuditReport => ({
    valid: !problem,
    entries,
    signaturesChecked,
    publicKeys: [...publicKeys],
    ...(problem ? { problem } : {}),
  });

  for (const [index, line] of lines.entries()) {
    const fail = (reason: string) => report(index, { line: index + 1, reason });
    let record: AuditRecord;
    try {
      record = JSON.parse(line);
    } catch {
      return fail("not valid JSON");
    }
    if (record.prevHash !== prevHash) return fail("doesn't follow the line before it");
    if (!record.entry || chainHash(record.entry, record.prevHash) !== record.hash) return fail("its hash doesn't match its content");
    if (record.entry.type === "verdict") {
      signaturesChecked += 1;
      publicKeys.add(record.entry.verdict.wardyPublicKey);
      if (!(await verifyVerdict(record.entry.verdict, expectedPublicKey))) return fail("verdict signature is invalid");
    }
    prevHash = record.hash;
  }
  return report(lines.length);
}
