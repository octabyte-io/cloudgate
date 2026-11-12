import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

// Brought onto the console's own geometry (e-console.html:463-470): 36px tall,
// 11px of side padding, sitting on --panel with the resting shadow rather than
// on a translucent fill. `text-base md:text-body` is base-nova's and stays —
// a 14px input is what makes iOS Safari zoom the whole page on focus, and
// 16px until the viewport is a laptop is the fix.
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-ctl w-full min-w-0 rounded-lg border border-input bg-panel px-2.75 py-1 text-base shadow-panel transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-tx-3 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-panel-2 disabled:text-tx-3 disabled:shadow-none aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-body dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
