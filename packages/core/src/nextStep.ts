// What an agent should do next, as a value it can act on without parsing English. An agent told only "failed" tends to
// try again, or try another way, so this always says.
import type { Verdict } from "./types.js";

export type NextStep =
  /** Paid. Don't send it again, even if something later says it failed. */
  | "done"
  /** Nothing is paid yet, and the owner decides. Ask for the status later. Don't retry. */
  | "wait_for_owner"
  /** Refused. Don't retry it or look for another way to pay. */
  | "stop"
  /** Something went wrong in custody, and money may or may not have moved. Don't retry. Tell the owner. */
  | "tell_owner"
  /** A check said it looks fine. Nothing was paid: use wardy_pay to pay. */
  | "ok_to_pay"
  /** A check found something the owner should see before paying. */
  | "ask_owner_first"
  /** A check says this payment shouldn't be made. */
  | "do_not_pay";

export function nextStepFor(verdict: Pick<Verdict, "mode" | "decision" | "execution">): NextStep {
  if (verdict.mode === "check") {
    if (verdict.decision === "ALLOW") return "ok_to_pay";
    return verdict.decision === "HOLD" ? "ask_owner_first" : "do_not_pay";
  }
  switch (verdict.execution?.status) {
    case "executed":
      return "done";
    case "pending_owner":
      return "wait_for_owner";
    case "failed":
    case "uncertain":
      return "tell_owner";
    default:
      return "stop";
  }
}
