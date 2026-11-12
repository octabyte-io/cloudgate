import { useQuery } from "@tanstack/react-query";

import { whitelabelingApi } from "@/lib/api/endpoints/whitelabeling";
import { keys } from "@/lib/api/keys";
import { normalizeBranding, UNBRANDED, type Branding } from "@/lib/branding/branding";

/**
 * The instance's branding, for anything in the browser that draws it.
 *
 * Cross-feature, hence `lib/api/`: the masthead, the sign-in mark, the style
 * block, the error pages and the Branding settings screen all read this one
 * key. Both layouts seed it from the server (`brandingState`), so on a first
 * load it is already in cache and nothing flashes.
 *
 * No `enabled` gate: the route is `@Public()` and the key is under `instance`,
 * so there is no Organization to wait for. `staleTime` matches the other
 * sign-in reads — it changes when an operator saves the Branding screen, which
 * invalidates it, and not otherwise.
 */
export function useBranding() {
  return useQuery({
    queryKey: keys.branding(),
    queryFn: async ({ signal }) =>
      normalizeBranding(await whitelabelingApi.get(signal)),
    staleTime: 5 * 60_000,
  });
}

/**
 * What to draw with: the stored branding, or Cloudgate's own while it is
 * unknown. A failed read is cosmetic, so it is drawn as unbranded rather than
 * as an error on every page.
 */
export function useBrandingOrDefault(): Branding {
  return useBranding().data ?? UNBRANDED;
}
