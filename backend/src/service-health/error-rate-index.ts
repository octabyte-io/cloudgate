import {
  composeDomainEntrypoints,
  composeRouterName,
  domainServiceName,
} from '../traefik/config/names';

/** The Services that can have an Error rate: the two a Domain routes to. */
export type ErrorRateServiceType = 'application' | 'compose';

/** A Service an Error rate belongs to. */
export interface ErrorRateOwner {
  serviceType: ErrorRateServiceType;
  serviceId: string;
}

/** One Domain row as the index reads it, with its Service's routing facts. */
export interface ErrorRateDomainRow {
  domainId: string;
  uniqueConfigKey: number;
  https: boolean;
  customEntrypoint: string | null;
  /** Exactly one of the two is set (`domain_exactly_one_parent`). */
  application: { applicationId: string; appName: string } | null;
  compose: {
    composeId: string;
    appName: string;
    composeType: 'docker-compose' | 'stack';
  } | null;
}

/** What one Traefik service name is, in Cloudgate's rows. */
export interface ErrorRateIndexEntry extends ErrorRateOwner {
  domainId: string;
}

/**
 * The forward index from Traefik service names to Domains (ADR-0027): every
 * name one Server's Domain rows make Traefik report, built with the same
 * builders that wrote the config, and matched exactly — never parsed, for
 * `traefik/config/names.ts`'s reason (`appName` carries `-`).
 *
 * - An Application Domain is one file-provider service,
 *   `domainServiceName(...)@file`, shared by its `web` and `websecure` routers.
 * - A `docker-compose` Compose Domain is one docker-provider service per
 *   entrypoint its labels route (`composeRouterName(...)@docker`); both map to
 *   the one Domain, so they sum as one.
 * - A `stack` Compose Domain is routed by the file provider the way an
 *   Application Domain is, so it is the same one
 *   `domainServiceName(...)@file` service, named after the Compose's
 *   `appName`.
 *
 * A name no row makes — the dashboard's own service, a removed Domain whose
 * series lingers until the next Traefik restart, anything else — is not in the
 * index and belongs to no Service.
 */
export function buildErrorRateIndex(
  rows: readonly ErrorRateDomainRow[],
): Map<string, ErrorRateIndexEntry> {
  const index = new Map<string, ErrorRateIndexEntry>();
  for (const row of rows) {
    if (row.application) {
      index.set(
        `${domainServiceName(row.application.appName, row.uniqueConfigKey)}@file`,
        {
          serviceType: 'application',
          serviceId: row.application.applicationId,
          domainId: row.domainId,
        },
      );
    } else if (row.compose?.composeType === 'stack') {
      index.set(
        `${domainServiceName(row.compose.appName, row.uniqueConfigKey)}@file`,
        {
          serviceType: 'compose',
          serviceId: row.compose.composeId,
          domainId: row.domainId,
        },
      );
    } else if (row.compose) {
      for (const entrypoint of composeDomainEntrypoints(row)) {
        index.set(
          `${composeRouterName(row.compose.appName, row.uniqueConfigKey, entrypoint)}@docker`,
          {
            serviceType: 'compose',
            serviceId: row.compose.composeId,
            domainId: row.domainId,
          },
        );
      }
    }
  }
  return index;
}
