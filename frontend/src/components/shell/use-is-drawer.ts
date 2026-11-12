import { useSyncExternalStore } from "react";

/**
 * Is the rail currently a drawer?
 *
 * The shell needs one thing CSS cannot give it. Below the `rail` breakpoint the
 * rail leaves the grid and slides *over* the page, and a closed drawer is still
 * in the tab order — `translateX(-101%)` moves ink, not focus. So a closed
 * drawer has to be `inert`, and `inert` is an attribute, which means React has
 * to know the width. Everything else that changes at that width is CSS, and
 * stays CSS.
 *
 * **The breakpoint is not written here.** `--breakpoint-rail` is declared once,
 * in `globals.css`, and Tailwind emits it as a real custom property on `:root`
 * (section 3b is a plain `@theme`, not `@theme inline`) — so the number can be
 * read back rather than copied. A literal here would be a second copy of a
 * design value in a file that is not allowed to hold one, free to drift from the
 * `@media` rules and the `railc` variant that share it.
 *
 * The server snapshot is `false`. On a phone that means one frame where the rail
 * is not yet inert — nothing is visible and nothing is focusable that early, and
 * the alternative is guessing a width on the server and being wrong on desktop.
 */
export function useIsDrawer(): boolean {
  return useSyncExternalStore(subscribe, matches, () => false);
}

let query: string | null = null;

function drawerQuery(): string {
  if (query === null) {
    const width = getComputedStyle(document.documentElement)
      .getPropertyValue("--breakpoint-rail")
      .trim();
    query = `(width < ${width})`;
  }
  return query;
}

function matches(): boolean {
  return window.matchMedia(drawerQuery()).matches;
}

function subscribe(listener: () => void) {
  const list = window.matchMedia(drawerQuery());
  list.addEventListener("change", listener);
  return () => list.removeEventListener("change", listener);
}
