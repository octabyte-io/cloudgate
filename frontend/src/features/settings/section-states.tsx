import { Card } from "@/components/console/card";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import { Icon } from "@/lib/design/icons";

/**
 * Waiting and refused, at **card** scale (F16).
 *
 * `TabPending` and `Outcome` are the console's versions of these and neither
 * fits here: both render their own `Page`, because both replace a whole screen,
 * and a settings section is already inside one — `SettingsPage` has drawn the
 * strip and the `<h1>` before the section is asked for anything. Nesting a
 * second `Page` would double the measure and the gutter, and an `Outcome`'s
 * `<h1>` would be the page's second.
 *
 * So this is the same two ideas one level down. `SectionPending` keeps the shape
 * of a card, on `TabPending`'s reasoning: nothing jumps when the real thing
 * lands. `SectionFailed` states the refusal in words rather than rendering an
 * empty list — which is the mistake F09 paid for three times over, and it is
 * sharper on these screens than anywhere else in the product, because "your role
 * cannot read this" and "there is nothing configured" are the two most different
 * sentences a settings page can say.
 */
export function SectionPending({
  title,
  rows = 3,
}: {
  title?: string;
  rows?: number;
}) {
  return (
    <Card aria-busy="true">
      <Card.Header>
        {title ? (
          <h2 className="text-body font-semibold text-tx">{title}</h2>
        ) : (
          <Skeleton className="h-4.5 w-40" />
        )}
      </Card.Header>
      <Card.Body className="space-y-3">
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton
            key={index}
            className="h-4"
            style={{ width: `${100 - index * 15}%` }}
          />
        ))}
      </Card.Body>
    </Card>
  );
}

export function SectionFailed({
  title,
  error,
  /** What the reader could do about it, when there is something. */
  children,
  /**
   * Read again. A failed read says "try again", so the card offers it
   * rather than sending the reader to reload the whole page.
   */
  onRetry,
}: {
  title: string;
  error: unknown;
  children?: React.ReactNode;
  onRetry?: () => void;
}) {
  return (
    <Card>
      <Card.Header title={title} headingLevel={2} />
      <Card.Body>
        <div className="flex gap-3">
          <span className="mt-0.5 flex size-7 flex-none items-center justify-center rounded-md border border-bad-line bg-bad-tint text-bad">
            <Icon name="alert" size={15} />
          </span>
          <div className="min-w-0">
            <p className="text-body wrap-anywhere text-tx">
              {errorMessage(error)}
            </p>
            {children ? (
              <p className="mt-1 text-meta text-tx-2">{children}</p>
            ) : null}
            {onRetry ? (
              <Button size="sm" className="mt-2.5" onClick={onRetry}>
                Try again
              </Button>
            ) : null}
          </div>
        </div>
      </Card.Body>
    </Card>
  );
}
