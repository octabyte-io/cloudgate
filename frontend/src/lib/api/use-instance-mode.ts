import { useQuery } from "@tanstack/react-query";

import type { InstanceMode } from "./endpoints/settings";
import { settingsApi } from "./endpoints/settings";
import { keys } from "./keys";

/**
 * Whether this is the Hosted instance or a Self-hosted one (ADR-0049),
 * off the public `GET /settings/about`.
 *
 * The console's one way to ask. Billing used to read `isCloud` off
 * `GET /billing/subscription`; the mode is a fact about the instance, which the
 * backend's instance-mode module answers here for everyone. Never refetched: it
 * cannot change without a restart.
 *
 * `data` is the mode; an older backend sends none and was
 * self-hosted.
 */
export function useInstanceMode() {
  return useQuery({
    queryKey: keys.instanceAbout(),
    queryFn: settingsApi.about,
    staleTime: Infinity,
    select: (about): InstanceMode => about.mode ?? "self-hosted",
  });
}
