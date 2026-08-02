"use client";

import { useEffect, useRef, type MutableRefObject } from "react";

/**
 * Keep the latest value of a frequently-changing callback in a ref, so effects
 * can invoke it without listing it as a dependency (which would otherwise
 * retrigger them whenever the caller passes a fresh inline function). The ref
 * is updated after render so it always holds the current callback.
 */
export function useCallbacksRef<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
