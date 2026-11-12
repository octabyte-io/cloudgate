import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { ServiceOutput } from "@/components/console/service-output";
import type { Database } from "@/lib/api/endpoints/databases";
import { useActiveOrganizationId } from "@/lib/auth/client";
import type { LiveLog } from "@/lib/realtime/live-log";

import { watchDatabase } from "./database-watch";

/**
 * What the engine itself is saying, live.
 *
 * **The brief asked whether a live database log stream exists. It does, and this
 * is it** — but not the one the question implies. There is no database-specific
 * gateway and there is nothing like an Application's build log, because a
 * database's deploy writes **no `deployment` row and no log file**: the shared
 * base pulls the image and converges the service inline
 * (`BaseDatabaseService.deployInternal`). So pressing Deploy on the tab beside
 * this produces a status change and, as far as any log file is concerned,
 * silence.
 *
 * What does exist is the **container's own output**, over
 * `/docker-container-logs` — the box an Application's Logs tab shares
 * (`ServiceOutput`). That is worth having on this screen precisely *because*
 * deploying is silent: `applicationStatus` going `done` means the Swarm
 * service converged, not that Postgres started — an engine that refuses its
 * data directory reports a healthy service and a container in a restart loop,
 * and this well is the only place that shows it.
 *
 * Its lines are Docker's stripped output (`--raw`), as they always were: six
 * third-party engines have six unrelated log formats, and a database runs one
 * copy, so there is nothing to name.
 */
export function ContainerLog({ database }: { database: Database }) {
  const { organizationId } = useActiveOrganizationId();
  const queryClient = useQueryClient();
  const watch = useCallback(
    (log: LiveLog) => watchDatabase(queryClient, organizationId, database, log),
    [queryClient, organizationId, database],
  );
  return (
    <ServiceOutput
      appName={database.appName}
      serverId={database.serverId}
      status={database.applicationStatus}
      name={database.name}
      noun="database"
      watch={watch}
    />
  );
}
