import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding font-medium whitespace-nowrap transition-[color,background-color,border-color,transform] duration-100 ease-out-strong outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:not-aria-disabled:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // ── cloudgate (e-console.html:436-470) ──────────────────────────
        // `gh` is the default: the neutral, bordered workhorse. A bare
        // <Button> must never come out brand-coloured by accident — on this
        // console a brand fill means "this is the one action on the screen".
        gh: "border-line bg-panel text-tx shadow-panel hover:border-line-2 hover:bg-raise",
        pri: "inset-ring inset-ring-brand-ring bg-brand text-primary-foreground shadow-panel hover:bg-brand-hi",
        qt: "bg-transparent text-tx-2 hover:bg-raise hover:text-tx",
        dngr: "border-bad-line bg-panel text-bad shadow-panel hover:bg-bad-tint",

        // ── base-nova's own, kept so a registry component that names one
        // still renders the way its author expected ─────────────────────
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // Three heights, all on the console's own geometry: 36 / 30 / 26. Every
      // size names its own text step, because a font-size inherited from the
      // base class and one set here would be two rules fighting over one
      // property.
      size: {
        default:
          "h-ctl gap-1.75 px-3.25 text-body has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        sm: "h-7.5 gap-1.5 px-2.5 text-ui has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6.5 gap-1 px-2 text-chip has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-ctl gap-2 px-4 text-body has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-ctl",
        "icon-sm": "size-7.5",
        "icon-xs": "size-6.5 [&_svg:not([class*='size-'])]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "gh",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "gh",
  size = "default",
  // An off action stays reachable. Base UI then marks it `aria-disabled`
  // instead of `disabled`, keeps it in the tab order, and still swallows the
  // click — which is what the one inert rule in globals.css keys on. A
  // control nobody can focus is a control that cannot say why it is off.
  focusableWhenDisabled = true,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      focusableWhenDisabled={focusableWhenDisabled}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
