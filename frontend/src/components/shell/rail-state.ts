"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the rail is collapsed to its icon strip — held on `<html>`, not in
 * React.
 *
 * Same reasoning as next-themes, and the same mechanism: a blocking script reads
 * localStorage and writes the attribute before first paint, so the rail is
 * already 60px wide when the first pixel lands. Held in React state instead, the
 * rail would open at 259px on every navigation and snap shut after hydration —
 * a 200px reflow of the entire page, once per page load.
 *
 * The layout reads the width from the attribute through CSS
 * (`globals.css` section 7). React reads the *same attribute* back through
 * `useSyncExternalStore`, which is what keeps the toggle's label and the
 * rendered width from ever disagreeing: there is one value, and neither side
 * owns a copy of it.
 */

const STORAGE_KEY = "cloudgate.rail";
const ATTRIBUTE = "data-rail";
const COLLAPSED = "collapsed";

/**
 * Injected into the root layout's `<head>` and run before paint.
 * A throw here must not take the app with it — private browsing modes make
 * `localStorage` itself throw on access — so a failed read just leaves the rail
 * expanded, which is the default anyway.
 */
export const RAIL_INIT_SCRIPT = `try{if(localStorage.getItem("${STORAGE_KEY}")==="${COLLAPSED}")document.documentElement.setAttribute("${ATTRIBUTE}","${COLLAPSED}")}catch(e){}`;

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isCollapsed(): boolean {
  return document.documentElement.getAttribute(ATTRIBUTE) === COLLAPSED;
}

/** Expanded on the server: nobody's preference is knowable there. */
export function useRailCollapsed(): boolean {
  return useSyncExternalStore(subscribe, isCollapsed, () => false);
}

export function toggleRail() {
  const next = !isCollapsed();
  const root = document.documentElement;

  if (next) root.setAttribute(ATTRIBUTE, COLLAPSED);
  else root.removeAttribute(ATTRIBUTE);

  try {
    localStorage.setItem(STORAGE_KEY, next ? COLLAPSED : "expanded");
  } catch {
    // A preference we could not persist is still a preference for this tab.
  }
  emit();
}
