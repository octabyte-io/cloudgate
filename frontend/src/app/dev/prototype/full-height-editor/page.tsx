import type { Metadata } from "next";
import { Suspense } from "react";

import { FullHeightEditorPrototype } from "./_components/prototype";

export const metadata: Metadata = {
  title: "Full-height editor prototype",
  description:
    "Three ways to open a file editor at the height of the screen: a dialog, full screen, or the card growing in place.",
};

/** Read per request, so `?show=` picks a variant. */
export const dynamic = "force-dynamic";

/**
 * A `/planning` prototype (PROTOTYPE.md): served only under `next dev`,
 * open signed out, and deleted when the full-height editor lands.
 */
export default function Page() {
  return (
    <Suspense>
      <FullHeightEditorPrototype />
    </Suspense>
  );
}
