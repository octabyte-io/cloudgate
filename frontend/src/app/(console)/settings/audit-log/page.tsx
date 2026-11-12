import type { Metadata } from "next";
import { Suspense } from "react";

import { AuditSection } from "@/features/enterprise/audit/audit-section";
import { SectionPending } from "@/features/settings/section-states";

import { SettingsPage } from "../_components/settings-page";

export const metadata: Metadata = { title: "Audit log" };

/**
 * **Rendered on demand, because the section reads its address**.
 * `?userId=` and `?outcome=` narrow the trail, so an Agent's row elsewhere can
 * link to its own entries. A prerendered route would serve one document for
 * every query string and file it in the client route cache under the empty
 * search it was built with — the trap `app/(console)/templates/page.tsx`
 * explains in full, including why Next 16's `cacheComponents` would
 * silently bring it back. `page.test.ts` pins this line.
 */
export const dynamic = "force-dynamic";

/**
 * The `Suspense` boundary is what `useSearchParams` demands of a route Next
 * may prerender; with the line above it is no longer demanded, and it is kept
 * for the moment it is again.
 */
export default function Page() {
  return (
    <SettingsPage slug="audit-log">
      <Suspense fallback={<SectionPending title="Audit log" rows={6} />}>
        <AuditSection />
      </Suspense>
    </SettingsPage>
  );
}
