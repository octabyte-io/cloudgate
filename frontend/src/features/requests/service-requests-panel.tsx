"use client";

import { useMemo } from "react";

import { Cols } from "@/components/console/cols";
import { EmptyState } from "@/components/console/empty-state";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import { errorMessage } from "@/lib/api/error-message";
import type {
  RequestsRead,
  ServiceRequestsRead,
} from "@/lib/api/endpoints/monitoring";
import {
  useActiveOrganizationId,
  useListOrganizations,
} from "@/lib/auth/client";
import type { IconName } from "@/lib/design/icons";

import { useServiceRequestsRead } from "../monitoring/use-monitoring";
import { RequestsBody } from "./requests-body";
import { PAGE_SIZE } from "./requests-log-card";
import { useRequestsAddress } from "./use-requests-address";

const LEDE = "Requests this Service received, read live from its Traefik.";

/**
 * **A Service's Requests tab**, on an Application or a Compose
 * stack: its Server's Access log, or the platform host's, fixed to this one
 * Service, without filtering the whole Server on the Requests page.
 *
 * - **The address needs no Server.** The backend finds the Service's Server
 *   itself, so a link to the tab keeps working wherever the Service runs; the
 *   range and the filters are in the address as on the Requests page.
 * - **The Requests page's body, less what picks lines by Service**: no Server
 *   picker, no Service filter and no Service column. The Server, or the
 *   platform host, is named under the title instead. The no-lines states,
 *   the "showing back to" note and the filters are the page's own
 *   (`RequestsBody`).
 * - **A Service in a Cloud account** runs on no Server with Traefik, so the
 *   tab says where its requests are logged instead (ADR-0035).
 * - **On the platform host** the tab reads that machine's log as this
 *   Service's (ADR-0061), and says so when some of its requests are withheld
 *   because another Organization holds the same hostname there.
 *
 * A Database has no Domain, gets no HTTP requests and has no such tab.
 */
export function ServiceRequestsPanel({
  serviceId,
  label,
  icon,
  aside,
}: {
  serviceId: string;
  label: string;
  icon: IconName;
  /** A card beside the tab, as every Compose tab carries its facts. */
  aside?: { node: React.ReactNode; label: string };
}) {
  const address = useRequestsAddress();
  const { bounds, term, classes, methods, page } = address;
  const query = useMemo(
    () => ({
      ...bounds,
      pageIndex: page,
      pageSize: PAGE_SIZE,
      search: term.trim() || undefined,
      status: classes.size > 0 ? [...classes] : undefined,
      method: methods.size > 0 ? [...methods] : undefined,
    }),
    [bounds, page, term, classes, methods],
  );
  const read = useServiceRequestsRead(serviceId, query);
  const { organizationId } = useActiveOrganizationId();
  const organizations = useListOrganizations();
  const organizationName =
    organizations.data?.find((each) => each.id === organizationId)?.name ??
    "this Organization";

  const answer = read.data;
  const serverRead = answer && isServerRead(answer) ? answer : undefined;

  const body = read.error ? (
    <p className="text-body text-tx-2">{errorMessage(read.error)}</p>
  ) : !answer ? (
    <div className="grid gap-2.5" aria-busy="true">
      <Skeleton className="h-row" />
      <Skeleton className="h-plot" />
    </div>
  ) : answer.state === "cloud-account" ? (
    <EmptyState icon="globe" title="No Requests for Cloud account Services">
      This Service runs in your cloud account, not on a Server with Traefik, so
      Cloudgate has no access log of its requests. Look at your cloud&apos;s own
      load balancer or CDN logs.
    </EmptyState>
  ) : (
    <RequestsBody
      address={address}
      read={{ ...read, data: serverRead }}
      serviceFilter={null}
      serviceColumn={false}
      organizationName={organizationName}
    />
  );

  const sections = <div className="flex flex-col gap-4.5">{body}</div>;
  return (
    <Page>
      <PageHeader
        title={label}
        icon={icon}
        lede={LEDE}
        strap={
          !serverRead
            ? undefined
            : serverRead.target.serverId === null
              ? "on the platform host"
              : `on Server ${serverRead.target.name}`
        }
      />
      {aside ? (
        <Cols aside={aside.node} asideLabel={aside.label}>
          {sections}
        </Cols>
      ) : (
        sections
      )}
    </Page>
  );
}

/** A read of a Traefik log, as against a Service in a Cloud account. */
function isServerRead(read: ServiceRequestsRead): read is RequestsRead {
  return read.state !== "cloud-account";
}
