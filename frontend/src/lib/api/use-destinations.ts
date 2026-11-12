import { useQuery } from "@tanstack/react-query";

import { useActiveOrganizationId } from "@/lib/auth/client";

import { destinationsApi } from "./endpoints/destinations";
import { keys } from "./keys";

/**
 * Where a backup is written — the Organization's S3 destinations.
 *
 * Built by F10 for a volume backup's destination picker and moved here by F11,
 * which is the second phase to need the same eight lines: a database backup and
 * a database restore both pick from this list, and so will F12's Compose
 * backups. **F15 owns the screen that manages them**; this is only the read, the
 * way `registries` and `ssh-keys` are reads that F09 declared for F15 and F13.
 *
 * It lives beside `use-invalidate.ts` rather than in a feature folder for the
 * reason that put it here: a list every feature picks from belongs to none of
 * them.
 */
export function useDestinations() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.destinations.list(organizationId),
    queryFn: () => destinationsApi.list(),
    enabled: organizationId !== null,
  });
}

/**
 * What is in one destination, under a prefix — `GET /destinations/:id/objects`.
 *
 * Sits beside `useDestinations` for the same reason it does: the volume restore
 * flow reads it today and a Compose volume restore will read the same lines.
 *
 * **Not refetched in the background.** The listing shells out to `rclone` against
 * somebody else's S3 endpoint, which is a network round trip the console should
 * make when it is asked to and not on every window focus. The picker carries a
 * Refresh button instead, so a tarball written a minute ago is one press away.
 */
export function useDestinationObjects(params: {
  destinationId: string;
  /**
   * `<appName>/<prefix>` — empty lists the whole bucket, which means
   * every prefix in it this caller is entitled to (plus the ones no Service
   * claims), not literally every key. A `.` or `..` segment is refused 400 by
   * the backend, which is `bucketKeySegments` keeping the segment the filter
   * decides on and the path rclone lists the same thing.
   */
  prefix: string;
  /** The Server rclone lists from; omitted, this Cloudgate host. */
  serverId?: string;
  enabled?: boolean;
}) {
  const { organizationId } = useActiveOrganizationId();
  const { destinationId, prefix, serverId, enabled = true } = params;
  return useQuery({
    queryKey: keys.destinations.objects(
      organizationId,
      destinationId,
      prefix,
      serverId ?? null,
    ),
    queryFn: () =>
      serverId
        ? destinationsApi.listObjects(destinationId, prefix, serverId)
        : destinationsApi.listObjects(destinationId, prefix),
    enabled: enabled && organizationId !== null && destinationId !== "",
    refetchOnWindowFocus: false,
  });
}
