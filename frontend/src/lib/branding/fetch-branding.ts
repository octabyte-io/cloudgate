import { BACKEND_INTERNAL_ORIGIN } from "@/lib/config";

import { normalizeBranding, UNBRANDED, type Branding } from "./branding";

/**
 * How long a server render waits for the branding before drawing the
 * unbranded door. Loopback on the shipped install, so this is only ever spent
 * when the backend is down — and then the sign-in form cannot work either.
 */
export const BRANDING_TIMEOUT_MS = 1_500;

/**
 * `GET /settings/whitelabeling`, from the Next server rather than a browser.
 *
 * **Why this one read happens on the server**, when `CODING_STANDARDS.md` §3.5
 * keeps every other read in TanStack Query: the document title and the
 * favicon are `<head>`, and the only thing that writes `<head>` without a
 * flash of the product's own name is a layout's metadata. The sign-in screen is
 * the surface `getWhitelabelingConfig`'s docblock gives as the reason the route
 * is public, and a tab that reads "Sign in · Cloudgate" until JavaScript runs
 * and then changes is the thing the operator bought white-labeling to avoid.
 *
 * It goes to `BACKEND_INTERNAL_ORIGIN`, the address the rewrites already use,
 * and **fails to the unbranded instance, never to an error**: a missing name is
 * cosmetic, and a sign-in screen that refused to render because branding did
 * not load would lock everybody out over a logo.
 */
export async function fetchBranding(
  fetchImpl: typeof fetch = fetch,
): Promise<Branding> {
  try {
    const response = await fetchImpl(
      `${BACKEND_INTERNAL_ORIGIN}/settings/whitelabeling`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(BRANDING_TIMEOUT_MS),
      },
    );
    if (!response.ok) return UNBRANDED;
    return normalizeBranding(await response.json());
  } catch {
    return UNBRANDED;
  }
}
