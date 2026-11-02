// A Merkle tree in the form RFC 6962 (Certificate Transparency) defines, so it can be checked against published test
// vectors. Leaves and inner nodes hash with different prefixes, so a node can't pose as a leaf. An odd node is promoted
// rather than duplicated, because duplicating lets two different lists share one root. Roots grow by appending: the
// root of the first n leaves never changes.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const LEAF_PREFIX = Uint8Array.of(0);
const NODE_PREFIX = Uint8Array.of(1);
const HASH_HEX = /^[0-9a-f]{64}$/;

function hashOf(prefix: Uint8Array, ...parts: Uint8Array[]): Uint8Array {
  const hasher = sha256.create().update(prefix);
  for (const part of parts) hasher.update(part);
  return hasher.digest();
}

function leafHash(leaf: string): Uint8Array {
  return hashOf(LEAF_PREFIX, hexToBytes(leaf));
}

/** The largest power of two below n: where RFC 6962 splits a list of n. */
function splitPoint(n: number): number {
  let split = 1;
  while (split * 2 < n) split *= 2;
  return split;
}

function subtreeHash(leaves: readonly string[]): Uint8Array {
  if (leaves.length === 1) return leafHash(leaves[0] as string);
  const split = splitPoint(leaves.length);
  return hashOf(NODE_PREFIX, subtreeHash(leaves.slice(0, split)), subtreeHash(leaves.slice(split)));
}

/** The root over leaves given as hex, in order. An empty tree's root is the hash of nothing. */
export function merkleRoot(leaves: readonly string[]): string {
  return bytesToHex(leaves.length === 0 ? sha256(new Uint8Array()) : subtreeHash(leaves));
}

export interface MerkleProof {
  leaf: string;
  index: number;
  /** How many leaves the tree had. A proof alone doesn't bind this: compare it to the anchored count. */
  count: number;
  /** Sibling hashes, from the leaf up to the root. */
  path: string[];
  root: string;
}

function auditPath(index: number, leaves: readonly string[]): string[] {
  if (leaves.length <= 1) return [];
  const split = splitPoint(leaves.length);
  return index < split
    ? [...auditPath(index, leaves.slice(0, split)), bytesToHex(subtreeHash(leaves.slice(split)))]
    : [...auditPath(index - split, leaves.slice(split)), bytesToHex(subtreeHash(leaves.slice(0, split)))];
}

export function merkleProof(leaves: readonly string[], index: number): MerkleProof {
  const leaf = leaves[index];
  if (leaf === undefined) throw new RangeError(`No leaf at index ${index}.`);
  return { leaf, index, count: leaves.length, path: auditPath(index, leaves), root: merkleRoot(leaves) };
}

/** What you already trust about a tree, such as what's on-chain. */
export interface TrustedRoot {
  root: string;
  count: number;
}

/**
 * Checks a proof using nothing but the proof: the algorithm of RFC 9162, section 2.1.3.2. Pass what you trust, such as
 * the on-chain anchor. Without it, this only shows the proof agrees with itself. The count needs that comparison most:
 * trees of 13 and 14 leaves can give a leaf the same path, so the hashes alone can't catch a false count. Never throws
 * on bad input.
 */
export function verifyMerkleProof(proof: MerkleProof, trusted?: TrustedRoot): boolean {
  const { leaf, index, count, path, root } = proof ?? {};
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 0 || index >= count || count > 2 ** 31) return false;
  if (!Array.isArray(path) || typeof root !== "string" || !HASH_HEX.test(root) || typeof leaf !== "string") return false;
  if (trusted !== undefined && (trusted.root !== root || trusted.count !== count)) return false;
  if (leaf.length % 2 !== 0 || !/^[0-9a-f]*$/.test(leaf)) return false;

  let node = index;
  let last = count - 1;
  let hash = leafHash(leaf);
  for (const sibling of path) {
    if (typeof sibling !== "string" || !HASH_HEX.test(sibling) || last === 0) return false;
    const siblingBytes = hexToBytes(sibling);
    if (node % 2 === 1 || node === last) {
      hash = hashOf(NODE_PREFIX, siblingBytes, hash);
      // A right edge with no sibling at this level: climb until there's one.
      if (node % 2 === 0) {
        while (node % 2 === 0 && node !== 0) {
          node = Math.floor(node / 2);
          last = Math.floor(last / 2);
        }
      }
    } else {
      hash = hashOf(NODE_PREFIX, hash, siblingBytes);
    }
    node = Math.floor(node / 2);
    last = Math.floor(last / 2);
  }
  return last === 0 && bytesToHex(hash) === root;
}
