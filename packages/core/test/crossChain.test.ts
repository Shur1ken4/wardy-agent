import { describe, expect, it } from "vitest";
import { looksLikeAddress } from "../src/accounts.js";
import { crossChainSignals, hasValidEvmChecksum } from "../src/detectors/crossChain.js";

const SOLANA = "So11111111111111111111111111111111111111112";
const EVM_CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"; // EIP-55's own test vector.
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function codes(payee: string, chain: string) {
  return crossChainSignals({ payee, chain }).map((signal) => signal.code);
}

describe("crossChainSignals", () => {
  it.each<[string, string]>([
    ["acme-shop.near", "near"],
    ["a".repeat(64), "near"],
    ["0x" + "a".repeat(40), "near"],
    ["sub.account.near", "near"],
    [SOLANA, "solana"],
    [EVM_CHECKSUMMED, "ethereum"],
    [USDC_BASE, "base"],
    [EVM_CHECKSUMMED.toLowerCase(), "arbitrum"],
    ["0x" + EVM_CHECKSUMMED.slice(2).toUpperCase(), "polygon"],
  ])("accepts %s on %s", (payee, chain) => {
    expect(codes(payee, chain)).toEqual([]);
  });

  it.each<[string, string, string]>([
    [SOLANA, "base", "not_an_evm_address"], // Scenario A6.
    ["acme-shop.near", "ethereum", "not_an_evm_address"],
    ["0x1234", "base", "not_an_evm_address"],
    ["0x" + "g".repeat(40), "base", "not_an_evm_address"],
    [EVM_CHECKSUMMED, "solana", "not_a_solana_address"],
    ["acme-shop.near", "solana", "not_a_solana_address"],
    ["O0Il" + "1".repeat(40), "solana", "not_a_solana_address"], // Letters base58 leaves out.
    ["Acme-Shop.near", "near", "not_a_near_account"],
    ["a", "near", "not_a_near_account"],
    ["a".repeat(65), "near", "not_a_near_account"],
    ["acme..shop.near", "near", "not_a_near_account"],
    ["-acme.near", "near", "not_a_near_account"],
    [SOLANA, "near", "not_a_near_account"],
  ])("refuses %s on %s", (payee, chain, problem) => {
    const [signal] = crossChainSignals({ payee, chain });
    expect(signal).toMatchObject({ code: "CHAIN_ADDRESS_MISMATCH", severity: "critical", points: 60, evidence: { chain, problem } });
  });

  it("refuses a mixed-case address with a broken checksum", () => {
    const broken = EVM_CHECKSUMMED.replace("aAeb", "AAeb");
    expect(crossChainSignals({ payee: broken, chain: "base" })[0]?.evidence.problem).toBe("bad_checksum");
  });

  it("says plainly when it can't check a chain, instead of passing it", () => {
    const [signal] = crossChainSignals({ payee: "anything", chain: "dogechain" });
    expect(signal).toMatchObject({ code: "CHAIN_NOT_CHECKED", severity: "low" });
  });
});

describe("hasValidEvmChecksum", () => {
  it.each([EVM_CHECKSUMMED, USDC_BASE, "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB"])(
    "accepts %s",
    (address) => {
      expect(hasValidEvmChecksum(address)).toBe(true);
    },
  );

  it("rejects one wrongly capitalised letter", () => {
    expect(hasValidEvmChecksum("0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBe(false);
  });
});

describe("looksLikeAddress", () => {
  it.each(["acme-shop.near", "sub.acme.near", EVM_CHECKSUMMED, "a".repeat(64), SOLANA])("%s is an address", (value) => {
    expect(looksLikeAddress(value)).toBe(true);
  });

  it.each(["Acme Shop", "Acme Shop Ltd.", "acmeshop", "Payments", "", "Invoice.Dept"])("%j isn't", (value) => {
    expect(looksLikeAddress(value)).toBe(false);
  });
});
