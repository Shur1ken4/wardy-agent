// Polls the Agent Market for hires and answers each with a check. Shared by the dev server, the hosted server and
// `npm run market:work`. Nothing here can pay: a hire gets a signed check and nothing else.
import type { PaymentService, Verdict } from "@wardy-agent/core";
import { AgentMarketClient, type EarningsLog, MarketWorker } from "@wardy-agent/providers";

export interface MarketLoopOptions {
  token: string;
  service: PaymentService;
  earnings: EarningsLog;
  publicUrl: string;
  everySeconds?: number;
  apiUrl?: string;
  log?: (line: string) => void;
}

export function marketWorker(options: MarketLoopOptions): MarketWorker {
  return new MarketWorker({
    market: new AgentMarketClient({ token: options.token, ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}) }),
    earnings: options.earnings,
    check: (request): Promise<Verdict> => options.service.check(request),
    publicUrl: options.publicUrl,
    ...(options.log ? { log: options.log } : {}),
  });
}

/** Polls until stopped. A failed poll is logged by its kind and the next one goes ahead. */
export function startMarketLoop(options: MarketLoopOptions): () => void {
  const worker = marketWorker(options);
  const log = options.log ?? ((line: string) => console.log(`Agent Market: ${line}`));
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await worker.poll();
    } catch (error) {
      log(`poll failed (${(error as Error).name}). Trying again next time.`);
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), (options.everySeconds ?? 60) * 1000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
