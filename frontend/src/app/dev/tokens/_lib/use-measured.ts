import { useRef, useSyncExternalStore } from "react";

/**
 * Measure something off the live document, and measure it again whenever the
 * theme changes.
 *
 * The theme is a class on `<html>`, so the DOM is the external system here and
 * a MutationObserver is the subscription — which is why this is a
 * `useSyncExternalStore` and not an effect. Two things fall out of that:
 *
 * - It works in a hidden tab. `requestAnimationFrame` does not fire while a tab
 *   is backgrounded, and an audit that reports "0 of 27 pass" because nothing
 *   was measured is worse than one that reports nothing at all.
 * - It picks up a theme change made in *another* tab, which next-themes syncs
 *   through storage without this component ever re-rendering.
 */
let version = 0;
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);

  if (!observer) {
    observer = new MutationObserver(() => {
      version += 1;
      for (const listener of listeners) listener();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
    }
  };
}

/**
 * `fallback` is what the server renders — it cannot know the visitor's theme,
 * let alone what their browser paints. Say so in the UI rather than presenting
 * an unmeasured value as a result.
 */
export function useMeasured<T>(measure: () => T, fallback: T): T {
  const cache = useRef<{ version: number; value: T } | null>(null);

  return useSyncExternalStore(
    subscribe,
    () => {
      if (!cache.current || cache.current.version !== version) {
        cache.current = { version, value: measure() };
      }
      return cache.current.value;
    },
    () => fallback,
  );
}
