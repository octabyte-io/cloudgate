"use client";

import dynamic from "next/dynamic";

import { TabPending } from "@/components/console/tab-pending";

/**
 * The gallery, client-only — and the reason is a defect this page found in
 * itself.
 *
 * Its fixtures are stamped **relative to now** (`ago(14 * MINUTE)`), because a
 * row shape whose whole job is to render "14 minutes ago" is only exercised by
 * times that really are minutes old. A Client Component still *prerenders* on the
 * server, so those stamps were computed twice — once per render — and React
 * reported a hydration mismatch on every `<time>` in three tables:
 * `dateTime="…:33.056Z"` against `…:32.732Z`, 324ms apart.
 *
 * `ssr: false` is the honest fix rather than freezing the fixtures to a fixed
 * date, which would have taken the branches this page exists to show
 * (`timeAgo`'s "just now", "3 minutes ago", "5 days ago") out of it.
 *
 * **The product's own screens cannot hit this**, which is why the fix is here and
 * not in `RowTime`: every row in the app arrives from a TanStack Query, so there
 * is nothing to render on the server and no first render to disagree with. It is
 * the standing rule in `lib/format/time.ts` — never call these from a Server
 * Component, and never prerender a screen that does — and a gallery is the one
 * place in the app that had a reason to break it.
 */
export const Gallery = dynamic(
  () => import("./rows").then((m) => ({ default: m.RowsGallery })),
  { ssr: false, loading: () => <TabPending /> },
);
