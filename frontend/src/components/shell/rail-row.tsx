/**
 * The one row recipe every rail row is cut from, so a group heading and a plain
 * link cannot end up different heights.
 */

// `relative` is load-bearing, not decoration: the label below becomes `sr-only`
// when the rail is an icon strip, and an absolutely positioned child with no
// containing block *here* resolves against the initial one and silently widens
// the document — the same trap F04 hit in table cells (e-console.html:617-619).
export const ROW =
  "relative flex h-nav items-center gap-2.5 rounded-md px-2.5 text-left text-ui font-medium text-tx transition-colors duration-100 hover:bg-raise railc:justify-center railc:gap-0 railc:px-0";

/** The lit row. Same fill as hover, and the label goes semibold to say so. */
export const CURRENT = "bg-raise";

/**
 * Hidden *visually* on the icon strip, never from the accessibility tree.
 * `display: none` would leave a nav item with no accessible name at all — the
 * icon beside it is `aria-hidden`, so the label is the only name there is.
 */
export const LABEL = "min-w-0 flex-1 truncate railc:sr-only";
