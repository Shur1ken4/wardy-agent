// Telling the owner a payment is waiting: a card on the page, and a system notification when the tab is in the background.
import { api } from "./api";
import type { Hold } from "./dashboard";
import { formatAmount } from "./format";
import { navigate } from "./router";

/**
 * The holds that weren't there last time. The first time it's called, nothing is new, because a payment that was
 * already waiting is in the list on the page, and the tab's title says so.
 */
export function newHolds(known: ReadonlySet<string> | null, holds: readonly Hold[]): Hold[] {
  if (!known) return [];
  return holds.filter((hold) => !known.has(hold.verdict.verdictId));
}

/** Words for both the card and the notification. Payee names come from the agent's request, so they're only ever text. */
export function holdAlertWords(hold: Hold): { title: string; body: string } {
  return {
    title: "A payment is waiting for you",
    body: `${formatAmount(hold.verdict.amount, hold.verdict.asset)} to ${hold.verdict.payee}. ${hold.verdict.reasons[0] ?? ""}`.trim(),
  };
}

/** Opens the approval page for a held payment, with a fresh one-time link. */
export async function openReview(verdictId: string): Promise<void> {
  const { approvalUrl } = await api.approvalLink(verdictId);
  const url = new URL(approvalUrl);
  navigate(`${url.pathname}${url.hash}`);
}

export type NotifyPermission = "unsupported" | "default" | "granted" | "denied";

export function notifyPermission(): NotifyPermission {
  if (typeof window === "undefined" || typeof window.Notification === "undefined") return "unsupported";
  return window.Notification.permission;
}

/** Asks the browser. It only works straight after a tap, so this is called from a button. */
export async function askToNotify(): Promise<NotifyPermission> {
  if (notifyPermission() === "unsupported") return "unsupported";
  try {
    return await window.Notification.requestPermission();
  } catch {
    return notifyPermission();
  }
}

/** A system notification, only when the tab isn't showing: on the page, the card says it already. */
export function notifyInBackground(hold: Hold, onOpen: () => void): void {
  if (notifyPermission() !== "granted" || document.visibilityState === "visible") return;
  const { title, body } = holdAlertWords(hold);
  try {
    // The same tag replaces an older notice for this payment rather than stacking a second one.
    const notice = new window.Notification(title, { body, tag: hold.verdict.verdictId, icon: "/shield.svg" });
    notice.onclick = () => {
      window.focus();
      notice.close();
      onOpen();
    };
  } catch {
    // Some browsers only allow notifications from a service worker. The card and the title still say it.
  }
}
