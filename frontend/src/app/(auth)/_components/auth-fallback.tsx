import { Card } from "@/components/console/card";
import { Skeleton } from "@/components/console/skeleton";

/**
 * The shape of an auth screen before its client component has mounted.
 *
 * It holds the *layout* and not the content: a title bar, a card, three rows. The
 * point is that nothing moves when the real screen replaces it — a door that jumps
 * as it opens is the first thing someone sees of this product.
 *
 * `aria-busy` on the region, `aria-hidden` on the bars (`Skeleton` sets that
 * itself), because four grey rectangles read aloud are worse than silence.
 */
export function AuthFallback() {
  return (
    <div aria-busy="true">
      <div className="mb-4">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="mt-3 h-3.5 w-full" />
      </div>
      <Card>
        <Card.Body className="grid gap-4 p-5">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-ctl" />
        </Card.Body>
      </Card>
    </div>
  );
}
