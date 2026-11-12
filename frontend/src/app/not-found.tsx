import { HydrationBoundary } from "@tanstack/react-query";
import Link from "next/link";

import { BrandMark } from "@/components/console/brand-mark";
import { BrandingStyle } from "@/components/console/branding-style";
import { ErrorPageCopy } from "@/components/console/error-page-copy";
import { brandedTitle, brandName } from "@/lib/branding/branding";
import { brandingState, loadBranding } from "@/lib/branding/load-branding";

import { NotFoundTitle } from "./not-found-title";

/**
 * An address that matched no route in the app at all.
 *
 * Next routes *unmatched* URLs to the root `not-found` (`v13.3.0` onwards), and
 * the root layout is the only thing above it — so unlike `(console)/not-found`
 * this cannot assume a console shell, an Organization, or even a session. It is
 * the doors' shape rather than the console's, for the same reason F06's screens
 * are: at this point we do not know who is reading.
 *
 * **Branded the way the doors are**: it reads the branding itself,
 * because neither layout that seeds it is above this page, and takes the name,
 * the marks, the colours and the operator's not-found sentence and support
 * link — and **not** the custom CSS, for the reason `BrandingStyle` gives: this
 * page is reached with no session, which makes it a door, and the stylesheet
 * stays off doors.
 *
 * No `Button` and no `LinkButton`: this page has one link and it is a link.
 */
export default async function NotFound() {
  const branding = await loadBranding();
  const name = brandName(branding);

  return (
    <HydrationBoundary state={brandingState(branding)}>
      <BrandingStyle customCss={false} />
      <main className="mx-auto grid min-h-dvh w-full max-w-auth place-content-center gap-4 px-6 py-16 text-center">
        {/* A `not-found.tsx` cannot export `metadata` — only `global-not-found`
            can — so the title is React's own hoisted `<title>`, kept first in
            `<head>` so it outranks the root layout's metadata one. */}
        <NotFoundTitle title={brandedTitle("Not found", branding)} />
        <div className="flex justify-center">
          <BrandMark />
        </div>
        <h1 className="text-sect text-tx">That page is not here.</h1>
        <p className="text-body text-tx-2">
          <ErrorPageCopy kind="notFound">
            The address may be mistyped, or the page may have moved. Signing in
            takes you to your Organization.
          </ErrorPageCopy>
        </p>
        <p>
          <Link
            href="/"
            className="text-body font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
          >
            Go to {name}
          </Link>
        </p>
      </main>
    </HydrationBoundary>
  );
}
