import { cn } from "@/lib/utils";

export type SectionHeadingProps = {
  title: React.ReactNode;
  /** One sentence under the heading. */
  lede?: React.ReactNode;
  actions?: React.ReactNode;
  /** Where this sits in the page outline. Under a PageHeader's `h1`, that is 2. */
  level?: 2 | 3;
  className?: string;
};

/**
 * A heading that divides a page into parts, with its controls on the same line
 * (e-console.html:427-431). Wraps rather than truncates: an Environment name
 * is not something to hide behind an ellipsis.
 */
export function SectionHeading({
  title,
  lede,
  actions,
  level = 2,
  className,
}: SectionHeadingProps) {
  const Heading = `h${level}` as const;
  return (
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      {/* A basis, not just `flex-1`: without one the heading squeezes down to
          four words a line rather than sending its actions to the next row. */}
      <div className="min-w-0 flex-[1_1_240px]">
        <Heading className="text-sect wrap-anywhere text-tx">{title}</Heading>
        {lede ? <p className="mt-1 text-body text-tx-2">{lede}</p> : null}
      </div>
      {actions ? (
        <div className="flex flex-none flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
