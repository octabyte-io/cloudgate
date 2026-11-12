import { Card } from "@/components/console/card";
import { Page } from "@/components/console/page";
import { Skeleton } from "@/components/console/skeleton";

/**
 * A tab whose panel is still arriving over the wire.
 *
 * Panels are lazily imported (`tab-registry.ts`), so the first visit to a tab
 * has one round trip in it. This is what fills the gap — and it is the *shape*
 * of a panel, not a spinner: a title, a lede, and the first card. Nothing jumps
 * when the real screen replaces it, which is the only reason to draw a skeleton
 * rather than nothing at all.
 *
 * It used to be every scope's `loading.tsx` as well. That route-level boundary is
 * gone (it flushed the shell, and a 200, before an undeclared slug could
 * 404), so this is now the lazy panels' fallback only.
 *
 * The skeletons are `aria-hidden` (F03), so the region carries `aria-busy` and
 * says what it is waiting for.
 */
export function TabPending() {
  return (
    <Page aria-busy="true" aria-describedby="tab-pending-label">
      <p id="tab-pending-label" className="sr-only">
        Loading this screen.
      </p>
      <div className="mb-5.5">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-2.5 h-4.5 w-full max-w-lede" />
      </div>
      <Card>
        <Card.Header>
          <Skeleton className="h-4.5 w-40" />
        </Card.Header>
        <Card.Body className="space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-2/3" />
        </Card.Body>
      </Card>
    </Page>
  );
}
