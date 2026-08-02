"use client";

/**
 * ToastStack — the CD&R notification surface. Renders the auto-expiring toast
 * queue (from useToasts) bottom-right. A toast appears only for NEW and
 * ESCALATED conflicts (dedup + severity gating happen upstream in the lifecycle
 * reducer); clicking one opens that conflict in the Conflict View.
 */

import type { Toast } from "@/lib/cdr/useToasts";

interface Props {
  toasts: Toast[];
  /** Dismiss a conflict's toast by its conflict id. */
  onDismiss: (conflictId: string) => void;
  /** Click a toast → open this conflict in the panel. */
  onOpen: (conflictId: string) => void;
}

const ICON: Record<Toast["severity"], string> = {
  LOS: "⛔",
  STCA: "⚠",
  MTCD: "◆",
};

export default function ToastStack({ toasts, onDismiss, onOpen }: Props) {
  if (toasts.length === 0) return null;
  return (
    <div className="cdr-toasts" role="region" aria-label="Conflict alerts">
      {toasts.map((t) => (
        <div
          key={t.conflictId}
          className={`cdr-toast sev-${t.severity.toLowerCase()}${
            t.kind === "auto" ? " cdr-toast-auto" : ""
          }`}
          role="alert"
        >
          <button
            type="button"
            className="cdr-toast-main"
            onClick={() => onOpen(t.conflictId)}
            title="Open in the Conflict Dashboard"
          >
            <span className="cdr-toast-ico" aria-hidden>
              {t.kind === "auto" ? "🤖" : ICON[t.severity]}
            </span>
            <span className="cdr-toast-text">
              <span className="cdr-toast-title">{t.title}</span>
              <span className="cdr-toast-body">{t.body}</span>
            </span>
          </button>
          <button
            type="button"
            className="cdr-toast-close"
            onClick={() => onDismiss(t.conflictId)}
            aria-label="Dismiss alert"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
