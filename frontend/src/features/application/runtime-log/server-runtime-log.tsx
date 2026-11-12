import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { Card } from "@/components/console/card";
import { ServiceOutput } from "@/components/console/service-output";
import {
  applicationsApi,
  type ApplicationDetail,
} from "@/lib/api/endpoints/applications";
import { keys, type OrganizationScope } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";
import type { LiveLog, LogEnding } from "@/lib/realtime/live-log";
import { watchServiceStatus } from "@/lib/realtime/service-status-watch";

import { LIVE_POLL_MS, useApplication } from "../use-application";

/** What an Application's Runtime log says while the Application is stopped. */
export const APPLICATION_STOPPED: LogEnding = {
  mark: "stopped",
  words: "Application stopped",
  sentence:
    "The Application is stopped — its Swarm service has no running task, so nothing is being written.",
};

/**
 * Have an Application's Runtime log follow its row's status wherever the log
 * is read (`watchServiceStatus`), on the key `useApplication` uses. `null`
 * before the Organization is known — nothing started, so `LiveLog.watch`
 * tries again.
 */
export function watchApplication(
  client: QueryClient,
  organizationId: OrganizationScope,
  application: Pick<ApplicationDetail, "applicationId" | "applicationStatus">,
  log: LiveLog,
): (() => void) | null {
  if (organizationId === null) return null;
  const { applicationId } = application;
  return watchServiceStatus({
    client,
    queryKey: keys.applications.detail(organizationId, applicationId),
    queryFn: () => applicationsApi.findOne(applicationId),
    status: application.applicationStatus,
    log,
    stopped: APPLICATION_STOPPED,
    pollMs: LIVE_POLL_MS,
  });
}

/**
 * The **Runtime log** of an Application on a Server or the platform host
 * (#1341): Docker's output for its Swarm service, named its `appName`, every
 * running copy merged by time and each line naming its copy (CONTEXT.md
 * **Runtime log**). Followed live over `/docker-container-logs`, the box a
 * database's Container output shares, with its Dock button.
 *
 * The row is read again every few seconds while it says `running` — a deploy
 * converging — because nothing pushes the move to `done`, and that move is
 * what dials a never-deployed Application's log for the first time.
 */
export function ServerRuntimeLogCard({
  application,
}: {
  application: ApplicationDetail;
}) {
  useApplication(application.applicationId, {
    live: application.applicationStatus === "running",
  });
  const { organizationId } = useActiveOrganizationId();
  const queryClient = useQueryClient();
  const watch = useCallback(
    (log: LiveLog) =>
      watchApplication(queryClient, organizationId, application, log),
    [queryClient, organizationId, application],
  );
  const place = application.server
    ? `Server ${application.server.name}`
    : "the platform host";

  return (
    <Card>
      <Card.Header
        title="Runtime log"
        sub={`Followed live from its Swarm service on ${place}, starting from the last 200 lines.`}
        headingLevel={2}
      />
      <Card.Body>
        <ServiceOutput
          appName={application.appName}
          serverId={application.serverId}
          status={application.applicationStatus}
          name={application.name}
          noun="Application"
          watch={watch}
          copies
        />
      </Card.Body>
    </Card>
  );
}
