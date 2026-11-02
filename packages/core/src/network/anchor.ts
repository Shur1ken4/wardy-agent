// The record of what was anchored on-chain. It's a convenience, not a source of trust: it says which root to expect
// and holds the leaves proofs are built from, and anyone can compare the root with the contract.
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { merkleRoot } from "./merkle.js";

const HASH = z.string().regex(/^[0-9a-f]{64}$/);

export const AnchorRecordSchema = z.strictObject({
  network: z.literal("testnet"),
  contractId: z.string().min(1),
  reporter: z.string().min(1),
  root: HASH,
  count: z.number().int().positive(),
  uri: z.string(),
  txHash: z.string().min(1),
  txUrl: z.url(),
  blockHeight: z.string().min(1),
  anchoredAt: z.string().min(1),
  leaves: z.array(HASH),
});

export type AnchorRecord = z.infer<typeof AnchorRecordSchema>;

/** Null unless the record is readable and agrees with itself, so a bad file can only mean "not anchored". */
export function readAnchorRecord(path: string): AnchorRecord | null {
  if (!existsSync(path)) return null;
  try {
    const record = AnchorRecordSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    return record.leaves.length === record.count && merkleRoot(record.leaves) === record.root ? record : null;
  } catch {
    return null;
  }
}
