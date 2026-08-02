"use client";

/**
 * Toast store for CD&R notifications — TRANSIENT alerts. A toast pops for a new
 * or escalating conflict and auto-dismisses after a short time (the persistent
 * record of every conflict now lives in the Conflict Dashboard, so the toasts
 * no longer need to be sticky). Keyed by CONFLICT ID so an escalation updates
 * the existing toast in place and re-sounds rather than stacking a duplicate.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { Severity } from "./types";

export interface Toast {
  /** Identity = the conflict id, so one conflict owns exactly one toast. */
  conflictId: string;
  severity: Severity;
  /** "new"/"escalated" = a conflict alert; "auto" = an auto-resolve confirmation. */
  kind: "new" | "escalated" | "auto";
  title: string;
  body: string;
}

/** Auto-dismiss delay (ms) per severity — LOS lingers longest. */
const TTL: Record<Severity, number> = { LOS: 8000, STCA: 6000, MTCD: 4500 };
/** Max simultaneous toasts before the oldest is dropped. */
const MAX_TOASTS = 6;

export interface ToastStore {
  toasts: Toast[];
  /** Add or update the toast for a conflict (upsert by conflictId); it will
   *  auto-dismiss after its severity TTL. */
  upsert: (t: Toast) => void;
  /** Remove a conflict's toast immediately (manual close, or on resolve). */
  dismiss: (conflictId: string) => void;
  /** Drop every toast (e.g. when CD&R stops running). */
  clear: () => void;
}

export function useToasts(): ToastStore {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (conflictId: string) => {
      clearTimer(conflictId);
      setToasts((ts) => ts.filter((t) => t.conflictId !== conflictId));
    },
    [clearTimer],
  );

  const upsert = useCallback(
    (t: Toast) => {
      // (Re)start the auto-dismiss timer for this conflict.
      clearTimer(t.conflictId);
      const timer = setTimeout(() => dismiss(t.conflictId), TTL[t.severity]);
      timers.current.set(t.conflictId, timer);
      setToasts((ts) => {
        const idx = ts.findIndex((x) => x.conflictId === t.conflictId);
        if (idx >= 0) {
          const next = ts.slice();
          next[idx] = t; // keep position on escalation
          return next;
        }
        return [...ts, t].slice(-MAX_TOASTS);
      });
    },
    [clearTimer, dismiss],
  );

  const clear = useCallback(() => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current.clear();
    setToasts([]);
  }, []);

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => clearTimeout(t));
      map.clear();
    };
  }, []);

  return { toasts, upsert, dismiss, clear };
}
