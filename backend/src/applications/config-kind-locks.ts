import { ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { privateAddress } from '../cloud-accounts/aws/definitions/private-dns';
import { byCloud } from '../cloud-accounts/cloud-provider';
import type { CloudKind } from '../cloud-accounts/cloud-account.schema';
import type { DrizzleDB } from '../db/drizzle.module';
import type { DrizzleTx } from '../environments/config-name';
import { closedDockerColumnRefusals } from '../native/docker-native';
import type { NativeDockerColumns } from '../native/docker-native';
import { application } from './application.schema';
import type { ApplicationConfigKind } from './application.schema';

type Db = DrizzleDB | DrizzleTx;

/**
 * What an Application's recorded config kind rules out, refused by
 * the backend so the API, MCP and the console all get the same answer
 * (ADR-0005). The console hides or disables the same controls and says the
 * same why.
 *
 * A **`web-private`** is reached only at its internal address, by
 * the other Services on its Server (`http://<appName>:<port>`) or of its
 * Environment network in a Cloud account: it takes
 * no Domain, publishes no port and has no previews, pull-request or
 * requested. With neither a Domain nor a published port, it can have no
 * Uptime check either.
 *
 * A **`worker`** serves no HTTP, so nothing may route a host to it:
 * no Domain, and no preview, a pull request's or a requested one, each of
 * which is reached at a host of its own. It has no port to publish, so the
 * port is not refused here.
 *
 * A **`cron`** (ADR-0034) has no Swarm service at all: each run is a
 * one-off job that publishes nothing and is gone when its command exits. So
 * a Domain, a published port or a preview could never reach it, and each is
 * refused rather than accepted and left doing nothing.
 *
 * The way out of each refusal is a kind change in the Project config, which
 * is a destroy and a create. The console says the same sentences, with a
 * period, in `frontend/src/features/application/config-kind.ts`; a change of
 * wording goes in both.
 */

/** A client branches on these, never on the message (ADR-0005). */
export const CONFIG_KIND_REFUSAL_CODE = {
  domain: 'KIND_TAKES_NO_DOMAIN',
  port: 'KIND_PUBLISHES_NO_PORT',
  previews: 'KIND_TAKES_NO_PREVIEWS',
} as const;

type Refused = keyof typeof CONFIG_KIND_REFUSAL_CODE;

/** Each kind's refusals, as the sentence the operator reads. */
const REFUSALS: Partial<
  Record<ApplicationConfigKind, Readonly<Partial<Record<Refused, string>>>>
> = {
  'web-private': {
    domain:
      'A Private web service takes no Domain: only other Services reach it, at its internal address. To serve it outside, change its kind to web in the Project config',
    port: 'A Private web service publishes no port: only other Services reach it, at its internal address. To serve it outside, change its kind to web in the Project config',
    previews:
      'A Private web service has no previews: a preview is reached at its own Domain, and a Private web service takes none. To preview it, change its kind to web in the Project config',
  },
  worker: {
    domain:
      'A worker takes no Domain: it serves no HTTP. To serve HTTP, change its kind to web in the Project config',
    previews:
      'A worker has no previews: a preview is reached at its own Domain, and a worker serves no HTTP. To serve HTTP, change its kind to web in the Project config',
  },
  cron: {
    domain:
      'A Cron service takes no Domain: each run is a fresh container that serves nothing and exits. To serve HTTP, change its kind to web in the Project config',
    port: 'A Cron service publishes no port: each run is a fresh container that serves nothing and exits. To serve on a port, change its kind to web in the Project config',
    previews:
      'A Cron service has no previews: a preview is reached at its own Domain, and a Cron service serves nothing. To preview it, change its kind to web in the Project config',
  },
};

/** The recorded kinds that have no previews, for the pull-request webhook's query. */
export const KINDS_WITHOUT_PREVIEWS: readonly ApplicationConfigKind[] = (
  Object.keys(REFUSALS) as ApplicationConfigKind[]
).filter((kind) => REFUSALS[kind]?.previews !== undefined);

/** Throws when `kind` rules `what` out; does nothing otherwise. */
export function assertKindAllows(
  kind: ApplicationConfigKind,
  what: Refused,
): void {
  const message = REFUSALS[kind]?.[what];
  if (message !== undefined) {
    throw new ConflictException({
      message,
      code: CONFIG_KIND_REFUSAL_CODE[what],
    });
  }
}

/** {@link assertKindAllows}, for an Application named by id. */
export async function assertApplicationKindAllows(
  db: Db,
  applicationId: string,
  what: Refused,
): Promise<void> {
  const [row] = await db
    .select({ configKind: application.configKind })
    .from(application)
    .where(eq(application.applicationId, applicationId))
    .limit(1);
  if (row) assertKindAllows(row.configKind, what);
}

/** A client branches on this, never on the message (ADR-0005). */
export const KIND_SWARM_SETTING_REFUSAL_CODE = 'KIND_TAKES_NO_SWARM_SETTING';

/**
 * Refuses a console save of Swarm settings a kind never takes
 * (ADR-0044 rule 9): a Cron service's health check, restart policy, update or
 * rollback, each named with its value and the reason `native.docker`'s plan
 * gives, from the same list (`DOCKER_KEYS_CLOSED_ON_KIND`). Clearing one
 * (`null`) is always allowed, so a row stored before the rule can be put
 * right in one save.
 */
export function assertKindTakesSwarmSettings(
  kind: ApplicationConfigKind,
  data: Partial<Record<keyof NativeDockerColumns, unknown>>,
): void {
  const refused = closedDockerColumnRefusals(kind, data);
  if (refused.length === 0) return;
  throw new ConflictException({
    message: `${kind === 'cron' ? 'A Cron service' : 'This Service'} takes no such Swarm setting: ${refused.join('; ')}`,
    code: KIND_SWARM_SETTING_REFUSAL_CODE,
  });
}

/**
 * Refuses an Application settings edit that switches previews on for a kind
 * that has none: either switch, the pull-request one or the requested one.
 * Switching one off is always allowed.
 */
export function assertPreviewSwitchesAllowed(
  kind: ApplicationConfigKind,
  data: {
    readonly isPreviewDeploymentsActive?: boolean | null;
    readonly requestedPreviewsAllowed?: boolean | null;
  },
): void {
  if (
    data.isPreviewDeploymentsActive === true ||
    data.requestedPreviewsAllowed === true
  ) {
    assertKindAllows(kind, 'previews');
  }
}

/**
 * The internal address other Services reach a `web-private` at: a base URL
 * with no path, used whole. `null` for every other kind.
 *
 * - **On a Server**, the other Services on that Server: Swarm's DNS
 *   on the shared `cloudgate-network` every Application joins resolves the
 *   service name, which is its `appName`.
 * - **In a Cloud account**, the Services of its own Environment network, by
 *   that cloud's private DNS: on AWS its Config name in the network's Cloud
 *   Map namespace; on Google Cloud its Cloud Run service's
 *   own `https://<service>-<project number>.<region>.run.app` URL,
 *   resolved inside the network by its private `run.app` zone, and known
 *   only once its first deploy has applied (`null` until then).
 */
export function internalAddressOf(
  app: {
    readonly configKind: ApplicationConfigKind;
    readonly appName: string;
    readonly configName: string | null;
    readonly port: number;
    /** Its Cloud Run service's saved `run.app` host, on Google Cloud. */
    readonly cloudRunAddress?: string | null;
  },
  place: { readonly cloud: CloudKind } | null,
): string | null {
  if (app.configKind !== 'web-private') return null;
  if (!place) return `http://${app.appName}:${app.port}`;
  return byCloud<() => string | null>(place.cloud, {
    aws: () => privateAddress(app.configName ?? app.appName, app.port),
    gcp: () => (app.cloudRunAddress ? `https://${app.cloudRunAddress}` : null),
  })();
}
