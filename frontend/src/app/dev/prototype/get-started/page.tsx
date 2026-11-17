import type { Metadata } from "next";
import { Suspense } from "react";

import { GetStartedPrototype } from "./_components/prototype";

export const metadata: Metadata = {
  title: "Get started prototype",
  description:
    "The get-started redesign's open layouts: buying a server, the wait after Buy, and the app's details.",
};

/** Read per request, so `?show=` picks a variant (the router trap on `/get-started`'s page). */
export const dynamic = "force-dynamic";

/**
 * A `/planning` prototype (PROTOTYPE.md): served only under `next dev`,
 * open signed out, and deleted when the redesign lands.
 */
export default function Page() {
  return (
    <Suspense>
      <GetStartedPrototype />
    </Suspense>
  );
}
