import { Card } from "@/components/console/card";
import { cn } from "@/lib/utils";

/**
 * The gallery's own shell — built out of the real Card, because a component
 * library whose showroom is made of something else is a library nobody has
 * checked.
 */
export function Section({
  title,
  blurb,
  source,
  children,
}: {
  title: string;
  blurb?: string;
  /** Where in the prototype this group's recipe lives. */
  source?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <Card.Header headingLevel={2} className="items-start">
        <div className="min-w-0 flex-1">
          <h2 className="text-sect text-tx">{title}</h2>
          {blurb ? (
            <p className="mt-1.5 max-w-lede text-body text-tx-2">{blurb}</p>
          ) : null}
        </div>
        {source ? (
          <span className="hidden flex-none font-mono text-meta text-tx-3 sm:block">
            {source}
          </span>
        ) : null}
      </Card.Header>
      <Card.Body className="flex flex-col gap-6">{children}</Card.Body>
    </Card>
  );
}

/** One specimen: what it is called, then the thing itself. */
export function Row({
  label,
  note,
  children,
  className,
}: {
  label: string;
  note?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <p className="text-ui font-medium text-tx-3">{label}</p>
        {note ? <p className="text-meta text-tx-3">{note}</p> : null}
      </div>
      <div className={cn("flex flex-wrap items-center gap-2.5", className)}>
        {children}
      </div>
    </div>
  );
}
