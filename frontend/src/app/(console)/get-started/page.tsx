import type { Metadata } from "next";
import { Suspense } from "react";

import { TabPending } from "@/components/console/tab-pending";
import { GetStartedScreen } from "@/features/get-started/get-started-screen";

export const metadata: Metadata = { title: "Get started" };

/**
 * Rendered on demand, for `/templates`' reason (its `page.tsx` has the whole
 * chain): prerendered, `/get-started` and `/get-started?template=ghost` are
 * one document whose baked router payload records an empty search, and the
 * route cache then files every deep link under the bare address. This page
 * is reached *only* by deep links (the templates website's Deploy buttons,
 * and Stripe's return), so it would be hit hardest.
 */
export const dynamic = "force-dynamic";

/** The screen reads its whole state with `useSearchParams`, which wants a boundary. */
export default function Page() {
  return (
    <Suspense fallback={<TabPending />}>
      <GetStartedScreen />
    </Suspense>
  );
}
