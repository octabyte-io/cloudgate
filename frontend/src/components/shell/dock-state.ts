"use client";

import { useSyncExternalStore } from "react";

/**
 * The Dock's shape — its height, and whether it is minimised or
 * maximised — held on `<html>`, not in React.
 *
 * The rail's collapsed state is the model and the mechanism (`rail-state.ts`):
 * a blocking script in the root layout's `<head>` reads localStorage
 * and writes the attribute and the height before first paint, so a Dock that
 * was left tall or maximised comes back that shape with nothing jumping. CSS
 * reads both (`globals.css` section 7); React reads the same attribute back
 * through `useSyncExternalStore`, so the header's buttons and the rendered
 * panel never disagree.
 *
 * What is persisted is the *shape*, never a session: a reload brings the Dock
 * back closed (triage, decision 3). The shape is applied the next time a shell
 * arrives in it.
 */

export type DockView = "normal" | "minimised" | "maximised";

const STORAGE_KEY = "cloudgate.dock";
const ATTRIBUTE = "data-dock";
const HEIGHT_PROPERTY = "--dock-h";

/**
 * The shortest the Dock may be dragged: its header and four lines of a 13px
 * terminal at a 1.25 line height, plus the well's padding — "a few lines".
 * Behaviour, not a design value: it sizes a gesture's limit.
 */
export const DOCK_MIN_HEIGHT = 136;

/**
 * The tallest a stored value may be, before the viewport is known. Anything
 * bigger is not a value this file wrote; the live clamp is `clampDockHeight`.
 */
const STORED_MAX = 4000;

/**
 * The masthead's height — a copy of `--spacing-top` (56px in `globals.css`),
 * which the Dock always leaves. A copy rather than a read of the token because
 * `clampDockHeight` is pure, and runs in the drag handler and in tests where
 * no stylesheet is loaded. It is not the authority: `.dock-panel`'s own
 * `min(var(--dock-h), calc(100dvh - var(--spacing-top)))` is, so if the two
 * drift a stored height is at most a few pixels too tall and CSS still caps it
 * (§3.4 keeps design values in `globals.css`; this one only bounds a gesture).
 */
const MASTHEAD = 56;

/**
 * Injected into the root layout's `<head>` beside `RAIL_INIT_SCRIPT` and run
 * before paint. A throw must not take the app with it — private browsing makes
 * `localStorage` itself throw — and a value of the wrong shape is ignored, so
 * either leaves the default shape.
 */
export const DOCK_INIT_SCRIPT = `try{var d=JSON.parse(localStorage.getItem("${STORAGE_KEY}")||"null"),r=document.documentElement;if(d){if(typeof d.height==="number"&&d.height>=${DOCK_MIN_HEIGHT}&&d.height<=${STORED_MAX})r.style.setProperty("${HEIGHT_PROPERTY}",d.height+"px");if(d.view==="minimised"||d.view==="maximised")r.setAttribute("${ATTRIBUTE}",d.view)}}catch(e){}`;

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

export function readDockView(): DockView {
  const value = document.documentElement.getAttribute(ATTRIBUTE);
  return value === "minimised" || value === "maximised" ? value : "normal";
}

/** The dragged height in px, or `null` while it is the default. */
export function readDockHeight(): number | null {
  const value =
    document.documentElement.style.getPropertyValue(HEIGHT_PROPERTY);
  const px = Number.parseFloat(value);
  return Number.isFinite(px) ? px : null;
}

/** Normal on the server: nobody's preference is knowable there. */
export function useDockView(): DockView {
  return useSyncExternalStore(subscribe, readDockView, () => "normal");
}

export function setDockView(view: DockView) {
  const root = document.documentElement;
  if (view === "normal") root.removeAttribute(ATTRIBUTE);
  else root.setAttribute(ATTRIBUTE, view);
  persist();
  emit();
}

/**
 * Set the height. A drag calls this on every step with `persist: false` and
 * once more at the end with `true`, so storage is written once per gesture.
 */
export function setDockHeight(px: number, options: { persist: boolean }) {
  document.documentElement.style.setProperty(
    HEIGHT_PROPERTY,
    `${Math.round(px)}px`,
  );
  if (options.persist) persist();
}

/** Between a few lines and the viewport less the masthead. */
export function clampDockHeight(px: number, viewport: number): number {
  return Math.round(
    Math.max(DOCK_MIN_HEIGHT, Math.min(px, viewport - MASTHEAD)),
  );
}

function persist() {
  const height = readDockHeight();
  const view = readDockView();
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(height === null ? { view } : { height, view }),
    );
  } catch {
    // Still this tab's shape, just not the next one's.
  }
}
