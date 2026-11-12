import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const chipVariants = cva(
  "inline-flex h-chip items-center gap-1.25 rounded-md border px-1.75 text-chip font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-line bg-panel-2 text-tx-2",
        /**
         * For a value that is a literal — an image tag, a commit, a port, a
         * branch. Mono because the reader is comparing characters, not
         * reading a word.
         */
        mono: "border-line bg-panel-2 font-mono tracking-tight text-tx-2",
        /** The one chip on a row that names what the row *is*. */
        brand: "border-brand-line bg-brand-tint text-brand-tx",
        /** Something kept but not working right now: "Allows nothing on Starter". */
        warn: "border-warn-line bg-warn-tint text-tx",
        /** Something still working while the rest around it stopped. */
        ok: "border-ok-line bg-ok-tint text-tx",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export type ChipProps = React.ComponentProps<"span"> &
  VariantProps<typeof chipVariants>;

/**
 * A small, static label (e-console.html:591-598). Not a status — a status is a
 * StatusPill, and it takes its colour from the enum rather than from whoever
 * placed it.
 */
export function Chip({ className, variant, ...props }: ChipProps) {
  return (
    <span
      data-slot="chip"
      className={cn(chipVariants({ variant }), className)}
      {...props}
    />
  );
}

export { chipVariants };
