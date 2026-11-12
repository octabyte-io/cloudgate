import { HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import Link from "next/link";

import { BrandMark } from "@/components/console/brand-mark";
import { BrandingStyle } from "@/components/console/branding-style";
import { brandingMetadata, brandName } from "@/lib/branding/branding";
import { brandingState, loadBranding } from "@/lib/branding/load-branding";

import { AuthBackdrop } from "./_components/auth-backdrop";

/**
 * The instance's name and favicon on every door. The sign-in screen is
 * the surface `GET /settings/whitelabeling` was made public *for*, so it is
 * resolved on the server and is in the first byte of `<head>` — see
 * `fetch-branding.ts` for why this is the one server-side read.
 */
export async function generateMetadata(): Promise<Metadata> {
  return brandingMetadata(await loadBranding());
}

/**
 * Everything before the console.
 *
 * A route group, so none of it shows up in a URL, and deliberately **not** the
 * console shell: no masthead, no scope rail, no ⌘K. There is nothing to navigate
 * yet, and a rail full of links that all refuse you is worse than no rail.
 *
 * The prototype has no sign-in screen, so this is derived from the system rather
 * than copied: the `--ground` page, the mark at its one size, one `Card` on
 * `--panel` at a narrow measure, centred in the opening of `AuthBackdrop`'s gate.
 * The drawing gives the door some character, but it stays in the theme's line
 * colour and recedes behind the form — the signature of this product is the
 * console, not the door, and nothing here should compete with the fields.
 *
 * No theme control here. The theme persists from the console (`next-themes`
 * writes it before paint), and a first visit opens light, which is what F01
 * decided the product opens as. A three-way segmented control under the sign-in
 * button would be the loudest thing on the page.
 *
 * **Branded, but without the operator's custom CSS**: the mark, the
 * title, the favicon and the colours follow the Branding screen; the stylesheet
 * does not reach a page with a password field on it. `BrandingStyle` says why.
 */
export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const branding = await loadBranding();

  return (
    <HydrationBoundary state={brandingState(branding)}>
      <BrandingStyle customCss={false} />
      {/*
       * `min-h-full` and not `h-dvh`: the taller screens here — sign-up is six
       * fields — must be able to grow past the viewport and scroll the page. The
       * console owns its own scrolling because it is a fixed shell; this is an
       * ordinary document, and letting it behave like one is why a 380px phone can
       * reach the submit button.
       */}
      {/*
       * `isolate` makes this the stacking context, so the backdrop's `-z-10`
       * lands above this `bg-ground` and below everything else in it.
       * `justify-center` puts a short screen in the gate's opening; a tall one
       * still starts at the top padding and scrolls.
       */}
      <div className="isolate flex flex-1 flex-col items-center justify-center bg-ground px-pad py-12">
        <AuthBackdrop />
        <Link
          href="/sign-in"
          aria-label={brandName(branding)}
          className="mb-7 flex items-center gap-2 rounded-sm"
        >
          <BrandMark />
        </Link>

        {/* The measure is the token, so every screen in the group is the same
            width and none of them decides for itself. */}
        <main className="w-full max-w-auth">{children}</main>
      </div>
    </HydrationBoundary>
  );
}
