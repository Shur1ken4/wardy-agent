import { describe, expect, it } from "vitest";
import { merkleProof, merkleRoot, verifyMerkleProof } from "../src/network/merkle.js";
import { sha256Hex } from "../src/hash.js";

const leafList = (n: number) => Array.from({ length: n }, (_, index) => sha256Hex(`leaf ${index}`));

// The published RFC 6962 test vectors, from Certificate Transparency's reference implementations. Not derived from
// this code: if the tree were built any other way, these would fail.
const RFC_LEAVES = ["", "00", "10", "2021", "3031", "40414243", "5051525354555657", "606162636465666768696a6b6c6d6e6f"];
const RFC_ROOTS = [
  "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
  "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
  "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
  "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
  "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
  "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
  "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
  "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328",
];

describe("merkleRoot", () => {
  it.each(RFC_ROOTS.map((root, index) => [index + 1, root] as const))("matches the RFC 6962 vector for %i leaves", (size, root) => {
    expect(merkleRoot(RFC_LEAVES.slice(0, size))).toBe(root);
  });

  it("the empty tree is the hash of nothing", () => {
    expect(merkleRoot([])).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("depends on order", () => {
    const [a, b] = leafList(2) as [string, string];
    expect(merkleRoot([a, b])).not.toBe(merkleRoot([b, a]));
  });

  it("depends on every leaf", () => {
    const leaves = leafList(9);
    for (let index = 0; index < leaves.length; index += 1) {
      const changed = [...leaves];
      changed[index] = sha256Hex("something else");
      expect(merkleRoot(changed)).not.toBe(merkleRoot(leaves));
    }
  });

  it("appending never changes the root of what came before", () => {
    const leaves = leafList(20);
    const first = merkleRoot(leaves.slice(0, 7));
    expect(merkleRoot(leaves.slice(0, 7))).toBe(first);
    expect(merkleRoot(leaves)).not.toBe(first);
  });

  it("doesn't let a list with its last leaf repeated share a root: the classic Merkle flaw", () => {
    const leaves = leafList(3);
    expect(merkleRoot([...leaves, leaves[2] as string])).not.toBe(merkleRoot(leaves));
  });

  it("a tree of one isn't just its leaf: leaves are prefixed", () => {
    const [leaf] = leafList(1) as [string];
    expect(merkleRoot([leaf])).not.toBe(leaf);
  });
});

describe("proofs", () => {
  it("every leaf proves, in trees of every size from 1 to 40", () => {
    for (let size = 1; size <= 40; size += 1) {
      const leaves = leafList(size);
      const root = merkleRoot(leaves);
      for (let index = 0; index < size; index += 1) {
        const proof = merkleProof(leaves, index);
        expect(proof.root).toBe(root);
        expect(verifyMerkleProof(proof, { root, count: size }), `size ${size}, index ${index}`).toBe(true);
      }
    }
  });

  it("matches the RFC's own tree too", () => {
    for (let index = 0; index < RFC_LEAVES.length; index += 1) {
      expect(verifyMerkleProof(merkleProof(RFC_LEAVES, index), { root: RFC_ROOTS[7] as string, count: 8 })).toBe(true);
    }
  });

  it("a proof is short: it grows with the log of the feed", () => {
    expect(merkleProof(leafList(1024), 500).path).toHaveLength(10);
  });

  it("a tree of one has an empty path", () => {
    expect(merkleProof(leafList(1), 0).path).toEqual([]);
  });

  it("refuses to prove a leaf that isn't there", () => {
    expect(() => merkleProof(leafList(3), 3)).toThrow(RangeError);
    expect(() => merkleProof(leafList(3), -1)).toThrow(RangeError);
  });

  describe("forgeries", () => {
    const leaves = leafList(13);
    const honest = merkleProof(leaves, 6);
    const flip = (hex: string) => `${hex[0] === "0" ? "1" : "0"}${hex.slice(1)}`;

    it.each<[string, () => Parameters<typeof verifyMerkleProof>[0]]>([
      ["another leaf", () => ({ ...honest, leaf: sha256Hex("forged report") })],
      ["a neighbour's index", () => ({ ...honest, index: 7 })],
      ["a far index", () => ({ ...honest, index: 2 })],
      ["a much smaller count", () => ({ ...honest, count: 7 })],
      ["a changed sibling", () => ({ ...honest, path: [flip(honest.path[0] as string), ...honest.path.slice(1)] })],
      ["a sibling removed", () => ({ ...honest, path: honest.path.slice(1) })],
      ["the last sibling removed", () => ({ ...honest, path: honest.path.slice(0, -1) })],
      ["a sibling added", () => ({ ...honest, path: [...honest.path, sha256Hex("extra")] })],
      ["siblings reordered", () => ({ ...honest, path: [...honest.path].reverse() })],
      ["a changed root", () => ({ ...honest, root: flip(honest.root) })],
    ])("rejects %s", (_name, forge) => {
      expect(verifyMerkleProof(forge())).toBe(false);
    });

    it("a self-consistent proof from another tree fails against the trusted root", () => {
      const fake = merkleProof([sha256Hex("forged report"), ...leafList(4)], 0);
      expect(verifyMerkleProof(fake)).toBe(true);
      expect(verifyMerkleProof(fake, { root: merkleRoot(leaves), count: fake.count })).toBe(false);
    });

    it("a false count that keeps the path's shape needs the anchor to catch it", () => {
      // Hashes can't bind the count: 13 and 14 leaves give leaf 6 the same path. This documents why the count is compared.
      const lying = { ...honest, count: 14 };
      expect(verifyMerkleProof(lying)).toBe(true);
      expect(verifyMerkleProof(lying, { root: honest.root, count: 13 })).toBe(false);
      expect(verifyMerkleProof(honest, { root: honest.root, count: 13 })).toBe(true);
    });

    it("an inner node can't pose as a leaf: the second-preimage attack", () => {
      // Two leaves hash up to one node. Claiming that node as a leaf of a smaller tree must fail.
      const tree = leafList(4);
      const root = merkleRoot(tree);
      const inner = merkleProof(tree.slice(0, 2), 0).root;
      const sibling = merkleRoot(tree.slice(2)); // The other half of the real tree.
      expect(verifyMerkleProof({ leaf: inner, index: 0, count: 2, path: [sibling], root })).toBe(false);
    });

    it.each<[string, unknown]>([
      ["nothing", undefined],
      ["an empty object", {}],
      ["a negative index", { ...honest, index: -1 }],
      ["an index past the end", { ...honest, index: honest.count }],
      ["a fractional index", { ...honest, index: 1.5 }],
      ["a huge count", { ...honest, count: Number.MAX_SAFE_INTEGER + 1 }],
      ["a zero count", { ...honest, count: 0 }],
      ["a leaf that isn't hex", { ...honest, leaf: "not hex" }],
      ["a leaf of odd length", { ...honest, leaf: "abc" }],
      ["a path that isn't a list", { ...honest, path: "abc" }],
      ["a sibling that isn't a hash", { ...honest, path: ["short"] }],
      ["an uppercase root", { ...honest, root: honest.root.toUpperCase() }],
    ])("rejects %s without throwing", (_name, input) => {
      expect(verifyMerkleProof(input as Parameters<typeof verifyMerkleProof>[0])).toBe(false);
    });
  });
});
