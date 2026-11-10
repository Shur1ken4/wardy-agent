import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { type Hold, useDashboard } from "../lib/dashboard";
import { formatAmount } from "../lib/format";
import { askToNotify, newHolds, notifyInBackground, notifyPermission, type NotifyPermission, openReview } from "../lib/holdAlerts";

/**
 * Says so the moment a payment starts waiting for the owner, on whatever page they're on. In a background tab it also
 * sends a system notification, if they've allowed it. Nothing here decides anything: Review opens the usual page.
 */
export function HoldAlert() {
  const { holds, needsCredential, stats } = useDashboard();
  // The holds arrive with the stats, so before those come there's no list yet to compare with.
  const loaded = stats !== null;
  const known = useRef<Set<string> | null>(null);
  const [showing, setShowing] = useState<Hold | null>(null);
  const [more, setMore] = useState(0);
  const [permission, setPermission] = useState<NotifyPermission>("unsupported");
  const [error, setError] = useState<string | null>(null);
  const reduced = useReducedMotion();

  useEffect(() => setPermission(notifyPermission()), []);

  useEffect(() => {
    if (needsCredential || !loaded) return;
    const fresh = newHolds(known.current, holds);
    known.current = new Set(holds.map((hold) => hold.verdict.verdictId));
    if (showing && !known.current.has(showing.verdict.verdictId)) {
      // Decided elsewhere, or expired: the card goes, rather than offering a review that can't happen.
      setShowing(null);
      setMore(0);
    }
    const newest = fresh[0];
    if (!newest) return;
    setShowing(newest);
    setMore(fresh.length - 1);
    setError(null);
    for (const hold of fresh) notifyInBackground(hold, () => void openReview(hold.verdict.verdictId).catch(() => undefined));
    // Only the list of holds says what's new, so the card showing isn't a reason to look again.
  }, [holds, needsCredential, loaded]);

  const close = () => {
    setShowing(null);
    setMore(0);
  };

  return (
    <div className="hold-alert-place" aria-live="polite">
      <AnimatePresence>
        {showing ? (
          <motion.section
            key={showing.verdict.verdictId}
            className="hold-alert"
            role="alertdialog"
            aria-labelledby="hold-alert-title"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.98 }}
            transition={{ duration: 0.28, ease: [0.2, 0, 0, 1] }}
          >
            <div className="hold-alert-head">
              <span className="hold-alert-pulse" aria-hidden="true" />
              <span className="eyebrow hold-alert-eyebrow">Waiting for you</span>
              <button type="button" className="hold-alert-close" aria-label="Close" onClick={close}>×</button>
            </div>
            <h2 id="hold-alert-title" className="hold-alert-title">
              {formatAmount(showing.verdict.amount, showing.verdict.asset)} to <span className="mono">{showing.verdict.payee}</span>
            </h2>
            <p className="hold-alert-why">{showing.verdict.reasons[0]}</p>
            <p className="note">Nothing is paid until you decide.{more > 0 ? ` ${more} more ${more === 1 ? "is" : "are"} waiting too.` : ""}</p>
            {error ? <p className="note note-error" role="alert">{error}</p> : null}
            <div className="hold-alert-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setError(null);
                  openReview(showing.verdict.verdictId).then(close, (caught: Error) => setError(caught.message));
                }}
              >
                Review
              </button>
              <button type="button" className="btn btn-secondary" onClick={close}>Later</button>
            </div>
            {permission === "default" ? (
              <button
                type="button"
                className="hold-alert-notify"
                onClick={() => void askToNotify().then(setPermission)}
              >
                Also tell me when this tab is in the background
              </button>
            ) : null}
            {permission === "denied" ? <p className="note hold-alert-small">Notifications are blocked for this site in your browser's settings.</p> : null}
          </motion.section>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
