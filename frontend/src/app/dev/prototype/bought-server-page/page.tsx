import type { Metadata } from "next";
import { Suspense } from "react";

import { BoughtServerPagePrototype } from "./_components/prototype";

export const metadata: Metadata = {
  title: "Bought Server page prototype",
  description:
    "Three places for a Bought Server's backups, size, storage and price: a tab on the Server, an Organization page, or Backups and Plan tabs.",
};

/** Read per request, so `?show=` picks a variant. */
export const dynamic = "force-dynamic";

/**
 * A `/planning` prototype (PROTOTYPE.md): served only under `next dev`,
 * open signed out, and deleted when the Bought Server page lands.
 */
export default function Page() {
  return (
    <Suspense>
      <BoughtServerPagePrototype />
    </Suspense>
  );
}
