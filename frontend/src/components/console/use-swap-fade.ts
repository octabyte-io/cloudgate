import { useLayoutEffect, useRef } from "react";

/**
 * Replays `animate-fade` on an element whenever `signal` changes, including
 * the first time it mounts: content replaced in place (design-system.md,
 * Motion) — a filter, a page or a range answered with a new set of rows.
 *
 * **Why a class toggle and not a `key`.** Remounting the table under a new key
 * would replay the animation for free, and would also throw away its sort
 * state, which lives inside `DataTable`. So the element stays and the class is
 * taken off, the box read once so the browser sees the removal, and put back.
 *
 * The signal should change when the *result* changes, never per keystroke or
 * per poll: a read answering after the filters moved, not the filters moving.
 * Put the ref on an element of its own — `animate-fade` fills `both`, so it
 * would hold `opacity: 1` over a sibling class that dims while fetching.
 */
export function useSwapFade<T extends HTMLElement>(signal: unknown) {
  const ref = useRef<T>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.classList.remove("animate-fade");
    // Reading layout flushes the removal, so re-adding restarts the keyframes.
    void element.offsetWidth;
    element.classList.add("animate-fade");
  }, [signal]);

  return ref;
}
