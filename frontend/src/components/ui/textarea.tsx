import * as React from "react"

import { cn } from "@/lib/utils"

// Brought onto the console's own geometry, the same way `input.tsx` was: on
// --panel with the resting shadow rather than a translucent fill, our own
// placeholder tone, and the disabled state that F03's one inert rule expects.
// `text-base md:text-body` is base-nova's and stays — a 14px control is what
// makes iOS Safari zoom the whole page on focus.
//
// `field-sizing-content` is base-nova's too, and it is why nothing here caps the
// height: a textarea holding a dotenv blob should grow with the blob, and the
// only place that could be wrong is inside a fixed box, where the caller sets a
// max and lets it scroll.
//
// It sizes the **width** to the content as well, and that is wrong everywhere
// the longest unbroken line became the textarea's min-content width, so
// a pasted PEM (64-character lines) pushed the grid column of the dialog around
// it wider than the dialog, which then scrolled sideways with Save cut off.
// `contain-inline-size` takes the content out of the width alone: `w-full` sets
// it, lines wrap inside the box, and the height still grows with them.
// `min-w-0` / `max-w-full` do not do this; measured in Chromium, the dialog
// still overflowed with both, because the textarea was never wider than 100%
// of a column that had already grown to fit it.
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content contain-inline-size min-h-16 w-full rounded-lg border border-input bg-panel px-2.75 py-2 text-base shadow-panel transition-colors outline-none placeholder:text-tx-3 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-panel-2 disabled:text-tx-3 disabled:shadow-none aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-body dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
