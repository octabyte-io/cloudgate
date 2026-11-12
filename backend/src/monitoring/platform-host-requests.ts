import type { LogEntry } from './access-log.parser';
import { platformHostMatcher, rowsTheCallerSees } from './server-access-log';
import type {
  DomainRoute,
  MatchedLine,
  PlatformHostRoute,
  RequestRow,
  ServiceChoice,
} from './server-access-log';

/**
 * The pure half of the platform host's Requests read (ADR-0061): which of
 * its lines a caller is sent, split per line against every Organization's
 * Domains there. Reading the file, and who holds what, are
 * `ServerAccessLogService`'s.
 */

/** A Service on the platform host, with the Organization whose it is. */
export interface PlatformHostService {
  serviceId: string;
  name: string;
  organizationId: string;
}

/** What the split needs to know about the caller and the read. */
export interface PlatformHostCaller {
  /** The Instance organization's authority: every line, each named. */
  instance: boolean;
  /** The platform-host Services of their active Organization they may read. */
  readableIds: ReadonlySet<string>;
  chosen: ServiceChoice | null;
}

/**
 * The rows the caller is sent, and how many lines were withheld from them
 * because the host is shared:
 *
 * - A line that matched a Service goes to a caller who may read it.
 * - A line that matched no Service — no Domain, or a host more than one
 *   Organization holds here — goes only to the Instance organization's
 *   authority, which also reads a shared host's line with the Service
 *   Traefik routed it to (`routedTo`).
 * - A shared host's line withheld from anyone else is counted in
 *   `withheldShared` when its host is one a Service the read covers holds,
 *   so a tab can say some of its requests can't be shown.
 */
export function platformHostRows(
  lines: LogEntry[],
  services: PlatformHostService[],
  routes: DomainRoute[],
  { instance, readableIds, chosen }: PlatformHostCaller,
): { rows: RequestRow[]; withheldShared: number } {
  const owners = new Map(
    services.map((service) => [service.serviceId, service.organizationId]),
  );
  const match = platformHostMatcher(
    routes.flatMap((route): PlatformHostRoute[] => {
      const organizationId = owners.get(route.serviceId);
      return organizationId === undefined ? [] : [{ ...route, organizationId }];
    }),
  );
  // The hosts of the Services this read covers, so a withheld shared line
  // is counted only where it could have been one of theirs.
  const covered = chosen ? chosen.serviceIds : readableIds;
  const coveredHosts = new Set(
    routes
      .filter(
        (route) =>
          covered.has(route.serviceId) && readableIds.has(route.serviceId),
      )
      .map((route) => route.host.toLowerCase()),
  );

  const matched = lines.map((line): MatchedLine & { sharedHost?: string } => {
    const found = match(line);
    if (found.kind === 'service') {
      return { line, serviceId: found.serviceId };
    }
    if (found.kind === 'shared') {
      // Named for the Instance organization's authority only; for anyone
      // else it matches no Service.
      return {
        line,
        serviceId: instance ? found.routedTo : null,
        sharedHost: found.host,
      };
    }
    return { line, serviceId: null };
  });

  let withheldShared = 0;
  const rows = rowsTheCallerSees(
    matched,
    (serviceId) =>
      instance || (serviceId !== null && readableIds.has(serviceId)),
    chosen,
    new Map(services.map((service) => [service.serviceId, service.name])),
    ({ sharedHost }) => {
      if (
        !instance &&
        sharedHost !== undefined &&
        coveredHosts.has(sharedHost)
      ) {
        withheldShared += 1;
      }
    },
  );
  return { rows, withheldShared };
}
