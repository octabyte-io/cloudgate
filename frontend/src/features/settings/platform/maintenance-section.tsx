"use client";

import { CleanupCard } from "./maintenance-cleanup-card";
import { MaintenanceDangerZone } from "./maintenance-danger-zone";
import { DiskUsageCard } from "./maintenance-disk-usage-card";
import { ScheduledCard } from "./maintenance-scheduled-card";

/**
 * What Docker is holding on this host, and the ways to get it back.
 *
 * **The reading comes first and the actions follow it**, which is the whole
 * shape of this screen: `docker system df` is the only thing on it that answers
 * "is this worth doing", and a page of prune buttons with no figures is a page
 * where somebody presses one to find out. The order below is that argument, which
 * is why it is a composition and each card is its own file.
 *
 * **Each cleanup names its command.** Not as decoration — `docker image prune
 * --all` and `docker image prune` differ by every image with no running
 * container, which on a build host is most of them. The exact command is the
 * only description of these that is both short and true, so it is on the row.
 *
 * **The two destructive ones are in the `DangerZone` and the five ordinary ones
 * are not**, which is the distinction the phase brief asks for by name: pruning
 * dangling images is a Tuesday-afternoon action, and `docker system prune --all`
 * takes every image not backing a running container — including the ones a
 * rollback point needs. Putting them in one list would say they were the same
 * kind of thing.
 */
export function MaintenanceSection() {
  return (
    <>
      <DiskUsageCard />
      <ScheduledCard />
      <CleanupCard />
      <MaintenanceDangerZone />
    </>
  );
}
