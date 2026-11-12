import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * `cn()` has to be told our theme, or it silently throws our classes away.
 *
 * tailwind-merge decides which of two classes wins by working out which CSS
 * property each one sets. Out of the box it knows Tailwind's own scales:
 * `text-sm` is a font size because `sm` is a t-shirt size, and anything else
 * after `text-` is assumed to be a colour (`color: [isAny]` in its default
 * theme). Our scale is *named* — `text-body`, `text-ui`, `text-chip` — so
 * every step of it looked like a colour, and
 * `cn("text-body", "text-primary-foreground")` collapsed to one class rather
 * than to a size and a colour.
 *
 * That is not cosmetic. It cost the primary button its white label (dropped
 * `text-primary-foreground`) and the segmented control its 13px (dropped
 * `text-ui`) — silently, in classes that were right there in the source.
 * Naming the scales here is what makes `cn()` tell the truth.
 *
 * Keep this in step with the `@theme` block in `src/app/globals.css`. A token
 * added there and not named here still works — right up until something tries
 * to override it.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      // The type scale (`--text-*`). Without these, every step reads as a
      // colour. Our role colours need no list: tailwind-merge's colour scale
      // is `isAny`, so `text-tx-2` and `text-brand-tx` already recognise each
      // other — it is the *sizes* that were being swallowed by that same
      // catch-all.
      text: [
        "disp",
        "sect",
        "lead",
        "body",
        "ui",
        "meta",
        "chip",
        "glyph",
        // F04's readouts and chart furniture.
        "fig",
        "hero",
        "tick",
        // F05's wordmark.
        "mark",
      ],

      // Geometry (`--spacing-*`): h-ctl against h-8, size-pill against size-4.
      spacing: [
        "top",
        "rail",
        "rail-c",
        "aside",
        "col",
        "ctl",
        "nav",
        "row",
        "thead",
        "pill",
        "chip",
        "pad",
        "pick",
        // F07's home page: a row of cards that fits itself.
        "tile",
        "modal-top",
        "modal-h",
        // F05's shell: the rail as a drawer, and the command palette.
        "drawer",
        "pal",
        "pal-top",
        "pal-list",
        "plot",
        "spark",
        "chart-side",
        "log",
        "frame",
      ],

      // Measures (`--container-*`), the pill radius, and the three elevations.
      container: ["col", "aside", "lede", "copy", "auth"],
      tracking: ["mono", "code"],
      leading: ["log", "diff"],
      radius: ["pill"],
      shadow: ["panel", "float", "pop"],
      breakpoint: ["hd", "lbl", "rail", "cols"],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
