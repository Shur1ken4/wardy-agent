// What Wardy Agent has earned, one line per accepted hire. Append-only JSONL, like the ledger, so the Earnings page
// never shows a number that didn't come from a real job.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Sale {
  assignmentId: string;
  jobId: string;
  /** The market's escrow for this job, in the market's own units, as it reported them. */
  amount: string;
  currency: string;
  verdictId: string;
  deliveredAt: string;
}

export interface EarningsSummary {
  checksSold: number;
  revenue: { currency: string; amount: string }[];
  lastSale?: { amount: string; currency: string };
  /** Hires that paid nothing, such as the market's free test runs. Answered, but not sales. Left out when there are none. */
  freeRuns?: number;
}

/** Adds decimal strings without floats: enough for prices with up to 12 decimals, which is what the market sends. */
function addDecimals(a: string, b: string): string {
  const scale = 12n;
  const toScaled = (value: string) => {
    const [whole = "0", fraction = ""] = value.split(".");
    return BigInt(whole) * 10n ** scale + BigInt((fraction + "0".repeat(Number(scale))).slice(0, Number(scale)));
  };
  const sum = toScaled(a) + toScaled(b);
  const unit = 10n ** scale;
  const fraction = (sum % unit).toString().padStart(Number(scale), "0").replace(/0+$/, "");
  return fraction ? `${sum / unit}.${fraction}` : `${sum / unit}`;
}

export class EarningsLog {
  private readonly sales: Sale[] = [];

  constructor(private readonly path?: string) {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) this.sales.push(JSON.parse(line) as Sale);
  }

  has(assignmentId: string): boolean {
    return this.sales.some((sale) => sale.assignmentId === assignmentId);
  }

  record(sale: Sale) {
    if (this.has(sale.assignmentId)) return;
    if (this.path) appendFileSync(this.path, `${JSON.stringify(sale)}\n`);
    this.sales.push(sale);
  }

  all(): Sale[] {
    return [...this.sales];
  }

  summary(): EarningsSummary {
    // A hire that paid nothing isn't a sale: the market's own test runs come in at 0.
    const paid = this.sales.filter((sale) => addDecimals(sale.amount, "0") !== "0");
    const freeRuns = this.sales.length - paid.length;
    const byCurrency = new Map<string, string>();
    for (const sale of paid) byCurrency.set(sale.currency, addDecimals(byCurrency.get(sale.currency) ?? "0", sale.amount));
    const last = paid.at(-1);
    return {
      checksSold: paid.length,
      revenue: [...byCurrency].map(([currency, amount]) => ({ currency, amount })),
      ...(last ? { lastSale: { amount: last.amount, currency: last.currency } } : {}),
      ...(freeRuns > 0 ? { freeRuns } : {}),
    };
  }
}
