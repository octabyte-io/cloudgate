import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

import {
  whitelabelingApi,
  type WhitelabelingPatch,
} from "@/lib/api/endpoints/whitelabeling";
import { useInvalidate } from "@/lib/api/use-invalidate";

/**
 * `PATCH /settings/whitelabeling`.
 *
 * Two things go stale on a save and they are refreshed two ways. The mark, the
 * colours, the custom CSS and the error-page copy are the `branding` query, so
 * invalidating it repaints them in place. The document title and the favicon
 * are the layouts' **server-resolved metadata**, which no query owns — so
 * `router.refresh()` re-renders the server half of the page and the tab takes
 * the new name without a reload.
 */
export function useUpdateBranding() {
  const invalidate = useInvalidate();
  const router = useRouter();
  return useMutation({
    mutationFn: (patch: WhitelabelingPatch) => whitelabelingApi.update(patch),
    onSuccess: async () => {
      await invalidate.branding();
      router.refresh();
    },
  });
}
