import type { Metadata } from "next";
import { Suspense } from "react";

import { RequestsScreen } from "@/features/requests/requests-screen";

export const metadata: Metadata = { title: "Requests" };

/**
 * **Rendered on demand, because the screen reads its address**: the Server
 * and every filter are in `?server=`, `?range=` and the rest, so a shared link
 * opens the same view. A prerendered route would serve one document for every
 * query string — the trap `app/(console)/templates/page.tsx` explains.
 */
export const dynamic = "force-dynamic";

/**
 * Offered to every customer, the Hosted instance's included: each one
 * reads their own Servers' logs, and the platform host's only with instance
 * authority (ADR-0053).
 *
 * The `Suspense` boundary is what `useSearchParams` demands of a route Next
 * may prerender; with `dynamic` above it is no longer demanded, and it is
 * kept for the moment it is again.
 */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <RequestsScreen />
    </Suspense>
  );
}
