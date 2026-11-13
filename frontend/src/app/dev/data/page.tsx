import type { Metadata } from "next";

import { ThemeToggle } from "@/components/console/theme-toggle";
import { backendOrigin, wsOrigin } from "@/lib/config";

import { Label, Mono } from "../tokens/_components/section";
import { OrganizationPanel } from "./_components/org-panel";
import { RefusalPanel } from "./_components/refusal-panel";
import { SessionPanel } from "./_components/session-panel";
import { SignedIn } from "./_components/signed-in";
import { StreamPanel } from "./_components/stream-panel";

export const metadata: Metadata = {
  title: "Data layer",
  description:
    "The F02 data layer, driven against a running backend: session, org scope, refusals and one live socket.",
};

/**
 * The harness the data layer is verified through. It exists so the claims F02
 * makes are checkable rather than asserted — a session that really signs in, an
 * org switch that really re-keys, a 403 that really does not sign anyone out,
 * and a socket that really streams.
 *
 * No design work happens here. F03 onwards builds the real screens; this page is
 * the proof, and stays plain on purpose.
 */
export default function DataLayerPage() {
  return (
    <div className="mx-auto flex w-full max-w-col flex-col gap-5 px-4 py-8 sm:px-6 sm:py-10">
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="text-disp text-tx">Data layer</h1>
            <p className="max-w-prose text-lead text-tx-2">
              Every later phase talks to the backend only through what is on this
              page. Drive it against a running backend and the whole layer is
              either working or visibly not.
            </p>
          </div>
          <ThemeToggle />
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line pt-3">
          <Label>Backend</Label>
          <Mono>{backendOrigin()}</Mono>
          <span className="text-tx-4" aria-hidden="true">
            ·
          </span>
          <Label>Sockets</Label>
          <Mono>{wsOrigin()}</Mono>
        </div>
      </header>

      <SessionPanel />
      <SignedIn>
        <OrganizationPanel />
        <RefusalPanel />
        <StreamPanel />
      </SignedIn>
    </div>
  );
}
