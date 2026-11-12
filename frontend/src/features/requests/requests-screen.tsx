"use client";

import { useEffect, useMemo } from "react";

import { EmptyState } from "@/components/console/empty-state";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { Picker } from "@/components/console/picker";
import { Skeleton } from "@/components/console/skeleton";
import { errorMessage } from "@/lib/api/error-message";
import type { RequestsTargets } from "@/lib/api/endpoints/monitoring";
import {
  useActiveOrganizationId,
  useListOrganizations,
  useSession,
} from "@/lib/auth/client";
import { usePermission } from "@/lib/auth/use-permission";

import {
  useRequestLogging,
  useRequestTargets,
  useRequestsRead,
} from "../monitoring/use-monitoring";
import { LoggingCard } from "./logging-card";
import { RequestsBody } from "./requests-body";
import { PAGE_SIZE } from "./requests-log-card";
import {
  PLATFORM_HOST,
  UNLISTED,
  chooseTarget,
  useLastViewedTarget,
} from "./requests-target";
import { NoServersMessage } from "./requests-unread";
import { useRequestsAddress } from "./use-requests-address";

/**
 * The Requests page: one Server's Access log at a time, read live over SSH
 * when the page asks (ADR-0056), showing only the lines of the Services the
 * person may read (ADR-0055). The platform host's log is one more entry for
 * the Instance organization's owners and admins, who read all of it, and for
 * anyone who can read a Service there, who reads only its lines (ADR-0061).
 * Its logging switch is shown only to who may flip it (`canSwitchLogging`).
 *
 * **Everything that decides the view is in the address** — the Server, the
 * Service filter (`service`, repeated, and `noService=1`), the range, status,
 * method, search and page — so a link opens the same view.
 * With no Server in the address it is the one last viewed in this browser,
 * then the first by name; a Server in the address the picker does not list
 * gets the usual "not found or not permitted" (`chooseTarget`).
 *
 * **One read answers the table, the chart and the totals**, so all three
 * count the same lines: after the split by Service and after every filter,
 * all applied by the backend over the whole window before it pages. What is
 * under the header is `RequestsBody`, which a Service's Requests tab shares.
 */
export function RequestsScreen() {
  const address = useRequestsAddress();
  const {
    params,
    bounds,
    term,
    classes,
    methods,
    serviceIds,
    noService,
    page,
    navigate,
  } = address;
  const { organizationId } = useActiveOrganizationId();
  const userId = useSession().data?.user.id ?? null;
  const lastViewed = useLastViewedTarget(userId, organizationId);
  const targets = useRequestTargets();

  const chosen = targets.data
    ? chooseTarget(targets.data, params.get("server"), lastViewed.value)
    : null;
  const unlisted = chosen === UNLISTED;
  const target = typeof chosen === "string" ? chosen : null;

  const remember = lastViewed.remember;
  useEffect(() => {
    if (target !== null) remember(target);
  }, [target, remember]);

  const query = useMemo(
    () => ({
      serverId: target === PLATFORM_HOST ? undefined : (target ?? undefined),
      ...bounds,
      pageIndex: page,
      pageSize: PAGE_SIZE,
      search: term.trim() || undefined,
      status: classes.size > 0 ? [...classes] : undefined,
      method: methods.size > 0 ? [...methods] : undefined,
      serviceId: serviceIds.size > 0 ? [...serviceIds] : undefined,
      noService: noService || undefined,
    }),
    [target, bounds, page, term, classes, methods, serviceIds, noService],
  );
  const read = useRequestsRead(query, target !== null);
  const organizations = useListOrganizations();
  const organizationName =
    organizations.data?.find((each) => each.id === organizationId)?.name ??
    "this Organization";
  // `POST /servers` is `server: ['create']`: owners and admins.
  const canAddServer = usePermission({ server: ["create"] }).allowed;

  return (
    <Page>
      <PageHeader
        title="Requests"
        icon="globe"
        lede="Requests your Services received, read live from the Server's Traefik."
        badges={
          targets.data && (target !== null || unlisted) ? (
            <TargetPicker
              targets={targets.data}
              value={target ?? ""}
              onChange={(next) => navigate({ server: next })}
            />
          ) : null
        }
      />

      <div className="flex flex-col gap-4.5">
        {targets.error ? (
          <p className="text-body text-tx-2">{errorMessage(targets.error)}</p>
        ) : targets.isPending ? (
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-row" />
            <Skeleton className="h-plot" />
          </div>
        ) : unlisted ? (
          <EmptyState icon="search" title="Server not found or not permitted">
            Cloudgate answers the same way for a Server that does not exist and
            one you may not read. Pick one of yours above.
          </EmptyState>
        ) : target === null ? (
          <NoServersMessage
            canAddServer={canAddServer}
            cloudAccountServices={targets.data?.cloudAccountServices === true}
          />
        ) : (
          <>
            {target === PLATFORM_HOST &&
            read.data?.canSwitchLogging === true ? (
              <PlatformHostLogging />
            ) : null}

            {/* The picker, in the header, stays live while the body's
                filters are greyed for a read with nothing to show. */}
            <RequestsBody
              address={address}
              read={read}
              serviceFilter={{
                services: read.data?.services ?? [],
                offersNoService: read.data?.noService === true,
                wholeServer: read.data?.wholeServer !== false,
                selected: { serviceIds, noService },
                onChange: (next) =>
                  navigate({
                    service: [...next.serviceIds],
                    noService: next.noService ? "1" : null,
                  }),
                disabled: !read.data,
              }}
              serviceColumn
              organizationName={organizationName}
            />
          </>
        )}
      </div>
    </Page>
  );
}

/** The platform host's own logging switch, as the page always showed it. */
function PlatformHostLogging() {
  const logging = useRequestLogging();
  return <LoggingCard logging={logging.data?.enabled === true} />;
}

/** The Server picker, beside the title. */
function TargetPicker({
  targets,
  value,
  onChange,
}: {
  targets: RequestsTargets;
  value: string;
  onChange: (value: string) => void;
}) {
  const options = [
    ...targets.servers.map((entry) => ({
      value: entry.serverId,
      label: entry.name,
    })),
    ...(targets.platformHost
      ? [{ value: PLATFORM_HOST, label: "Platform host" }]
      : []),
  ];
  return (
    <>
      <label htmlFor="requests-server" className="sr-only">
        Server
      </label>
      <Picker
        id="requests-server"
        options={options}
        value={value}
        placeholder="Choose a Server"
        onValueChange={onChange}
        className="w-56"
      />
    </>
  );
}
