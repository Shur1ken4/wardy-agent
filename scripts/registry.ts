// The Wardy Network's contract on NEAR testnet, and where its public record lives. Reading needs no keys.
import { type NetworkReport, verifyReportEvidence } from "@wardy-agent/core";
import { provider } from "./testnet.js";

export const REGISTRY_ID = "wardy-agent-registry.testnet";
export const REPORTER_ID = "wardy-agent-reporter.testnet";
/** Exactly what was anchored, line by line, so anyone can recompute the root. */
export const FEED_FILE = "config/network-feed.testnet.jsonl";
export const ANCHOR_FILE = "config/network-anchor.testnet.json";
export const DUMMY_URI = "hello-contract dummy root, not a real report feed";

export interface AnchoredRoot {
  root: string;
  count: number;
  uri: string;
  block_height: string;
  reporter: string;
}

export async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  return provider.callFunction({ contractId: REGISTRY_ID, method, args }) as Promise<T>;
}

export const latestRoot = () => view<AnchoredRoot | null>("get_latest_root");

/** A dummy root is only for proving the contract works. Once a real feed is anchored, one would replace it as the latest. */
export const mayAnchorDummy = (latest: AnchoredRoot | null): boolean => latest === null || latest.uri === DUMMY_URI;

/**
 * Why a report can't go on-chain, if there's a reason. Nothing goes up unless it verifies, seeds must say they're seeds,
 * and a real run's report has to be about a testnet account that's either unregistered or ours: a demo must never accuse
 * someone real.
 */
export async function reasonToRefuse(report: NetworkReport, source: "seed" | "real run", isSomeoneElses: (accountId: string) => Promise<boolean>): Promise<string | null> {
  if (!(await verifyReportEvidence(report))) return `The report about ${report.payee} doesn't verify.`;
  if (source === "seed") return report.seed === true ? null : `The seed feed has an unlabelled report about ${report.payee}.`;
  if (report.seed) return `--feed is for real testnet runs, and the report about ${report.payee} is labelled as seed.`;
  if (!report.payee.endsWith(".testnet")) return `Refusing to publish a demo report about ${report.payee}: it isn't a testnet account.`;
  if (await isSomeoneElses(report.payee)) return `Refusing to publish a report about ${report.payee}: it's a real account we don't control.`;
  return null;
}
