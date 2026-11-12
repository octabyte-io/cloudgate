import { useId } from "react";

import { cn } from "@/lib/utils";

/** The cloud's silhouette: a base and three puffs, on the mark's 64-unit grid. */
const CLOUD = (
  <>
    <rect x="3" y="33" width="58" height="19" rx="9.5" />
    <circle cx="19" cy="34" r="9.5" />
    <circle cx="37" cy="28" r="13" />
    <circle cx="50" cy="35.5" r="8" />
  </>
);

/**
 * Cloudgate's glyph: a cloud cut into three diagonal leaves of a gate, with a
 * keyhole in the middle leaf. It draws in `currentColor`, so it takes the
 * brand colour from its class and follows the theme. The leaves step down in
 * opacity rather than using three colours, so it stays one ink on any ground.
 *
 * The same drawing ships as `public/icon.svg`, `public/favicon.ico` and the
 * `cloudgate-mark*.svg` files. Change them together.
 *
 * Its clip and mask ids come from `useId`, because the masthead and a sheet
 * can draw it twice on one page, and a duplicated id would make the second
 * one resolve to the first one's mask.
 */
export function CloudgateGlyph({
  size = 20,
  className,
}: {
  size?: number;
  className?: string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const leaf = (n: string) => `cg-${id}-${n}`;
  return (
    <svg
      viewBox="2 3.5 60 60"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={cn("flex-none", className)}
    >
      <defs>
        <clipPath id={leaf("a")}>
          <polygon points="0,0 25,0 17,64 0,64" />
        </clipPath>
        <clipPath id={leaf("b")}>
          <polygon points="28,0 44,0 36,64 20,64" />
        </clipPath>
        <clipPath id={leaf("c")}>
          <polygon points="47,0 64,0 64,64 39,64" />
        </clipPath>
        <mask id={leaf("k")} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect width="64" height="64" fill="#fff" />
          <circle cx="31.7" cy="34" r="2.8" fill="#000" />
          <path d="M30.6 35 L29.4 42.5 H33.2 L32.8 35 Z" fill="#000" />
        </mask>
      </defs>
      <g fill="currentColor" mask={`url(#${leaf("k")})`}>
        <g clipPath={`url(#${leaf("a")})`}>{CLOUD}</g>
        <g clipPath={`url(#${leaf("b")})`} opacity={0.75}>
          {CLOUD}
        </g>
        <g clipPath={`url(#${leaf("c")})`} opacity={0.5}>
          {CLOUD}
        </g>
      </g>
    </svg>
  );
}
