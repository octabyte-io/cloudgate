import { eq } from 'drizzle-orm';

import { googleRefusalReason } from '../cloud-accounts/gcp/api-off';
import { VALKEY_ENDPOINTS } from '../cloud-accounts/gcp/definitions/existing-valkey-definition';
import { networkName } from '../cloud-accounts/gcp/definitions/names';
import {
  addEndpointsCommand,
  forwardingRuleName,
  parseValkeyName,
  valkeyRegistered,
} from '../cloud-accounts/gcp/plan-reader/existing-valkey';
import type { ValkeyLookup } from '../cloud-accounts/gcp/plan-reader/existing-valkey';
import {
  NOT_FOUND,
  PERMISSION_DENIED,
} from '../cloud-accounts/google-cloud.port';
import type {
  GoogleAccessToken,
  GoogleCloudPort,
  MemorystoreInstanceRead,
} from '../cloud-accounts/google-cloud.port';
import { describeError } from '../common/describe-error';
import type { DrizzleDB } from '../db/drizzle.module';
import { existingDatabase } from '../db/schema';
import type { ExistingDatabase, ExistingEndpoint } from '../db/schema';

/**
 * An existing Valkey's lookup and its registration (the Google Cloud buckets spec
 * "Existing Cloud SQL and Valkey"): Memorystore read through the Google
 * client port, and whether the operator has registered Cloudgate's two
 * endpoints on it yet — the one step only they can take, which the page
 * shows as the exact `--add-endpoints` command. Nothing waits on the
 * registration: linked Services deploy regardless.
 */

/** The page's status until a read finds both endpoints registered. */
export const WAITING_FOR_REGISTRATION = 'waiting for registration';

/**
 * Memorystore's answer for `identifier` as a lookup judges it, or why
 * Google could not be asked (a refusal of the plan's step, not of the
 * instance).
 */
export async function lookUpValkey(
  google: GoogleCloudPort,
  token: GoogleAccessToken,
  context: {
    readonly serviceName: string;
    readonly identifier: string;
    /** The Environment's project, whose API-off refusals name it. */
    readonly projectId: string;
  },
): Promise<
  | { readonly ok: true; readonly lookup: ValkeyLookup }
  | { readonly ok: false; readonly reason: string }
> {
  const parts = parseValkeyName(context.identifier);
  if (!parts) return { ok: true, lookup: { kind: 'missing' } };
  try {
    const answer = await google.memorystoreInstance(token, parts);
    if (answer.ok) {
      return { ok: true, lookup: { kind: 'found', instance: answer.value } };
    }
    if (answer.code === NOT_FOUND) {
      return { ok: true, lookup: { kind: 'missing' } };
    }
    if (answer.code === PERMISSION_DENIED) {
      return {
        ok: true,
        lookup: { kind: 'unreadable', message: answer.message },
      };
    }
    return {
      ok: false,
      reason: googleRefusalReason(
        `${context.serviceName}: Google Cloud could not be asked for the existing cache ${context.identifier}: ${answer.code}: ${answer.message}`,
        context.projectId,
      ),
    };
  } catch (error) {
    return {
      ok: false,
      reason: `${context.serviceName}: Google Cloud could not be reached for the existing cache ${context.identifier}: ${describeError(error)}. Check for changes to read it again`,
    };
  }
}

/** Cloudgate's two forwarding rules, by relative name, as the instance lists them once registered. */
export function madeRules(
  projectId: string,
  region: string,
  endpoints: readonly ExistingEndpoint[],
): string[] {
  return endpoints.map((one) =>
    forwardingRuleName(projectId, region, one.name),
  );
}

/**
 * Keeps whether both of Cloudgate's endpoints are registered on the
 * instance, as `instance` reads it, for its page. Nothing when no
 * endpoint is made yet. Answers what it saved.
 */
export async function saveRegistration(
  db: DrizzleDB,
  existing: Pick<
    ExistingDatabase,
    'existingDatabaseId' | 'region' | 'endpoints'
  >,
  projectId: string,
  instance: MemorystoreInstanceRead,
): Promise<'waiting' | 'registered' | null> {
  const endpoints = existing.endpoints ?? [];
  if (endpoints.length === 0) return null;
  const status = valkeyRegistered(
    instance,
    madeRules(projectId, existing.region, endpoints),
  )
    ? 'registered'
    : 'waiting';
  await db
    .update(existingDatabase)
    .set({
      registrationStatus: status,
      endpointCheckedAt: new Date().toISOString(),
    })
    .where(
      eq(existingDatabase.existingDatabaseId, existing.existingDatabaseId),
    );
  return status;
}

/**
 * What an existing Valkey's page shows of its registration: the
 * status, and while it waits the exact command that registers both
 * endpoints. `null` until the endpoints are made.
 */
export interface ValkeyRegistrationView {
  readonly status: 'waiting' | 'registered';
  /** "waiting for registration" while it waits, `null` once registered. */
  readonly sentence: string | null;
  /** The `gcloud … --add-endpoints` command, while it waits. */
  readonly command: string | null;
  readonly checkedAt: string | null;
  /** Each endpoint as made: its name and address. */
  readonly endpoints: readonly {
    readonly name: string;
    readonly address: string;
  }[];
}

export function valkeyRegistrationView(
  existing: ExistingDatabase,
  place: {
    /** The Environment's project, where the endpoints are. */
    readonly projectId: string;
    readonly environmentId: string;
  },
): ValkeyRegistrationView | null {
  const parts = parseValkeyName(existing.identifier);
  const endpoints = existing.endpoints ?? [];
  if (!parts || endpoints.length === 0) return null;
  const status = existing.registrationStatus ?? 'waiting';
  const ordered = VALKEY_ENDPOINTS.flatMap((endpoint) =>
    endpoints.filter((one) => one.endpoint === endpoint),
  );
  return {
    status,
    sentence:
      status === 'registered'
        ? null
        : `Cloudgate's two endpoints to ${existing.identifier} are made and ${WAITING_FOR_REGISTRATION}: run the command below once, then Check for changes. Linked Services are deployed meanwhile and reach it once it is registered`,
    command:
      status === 'registered'
        ? null
        : addEndpointsCommand({
            instance: parts,
            projectId: place.projectId,
            network: `projects/${place.projectId}/global/networks/${networkName(place.environmentId, 'net')}`,
            endpoints: ordered,
          }),
    checkedAt: existing.endpointCheckedAt,
    endpoints: ordered.map((one) => ({ name: one.name, address: one.address })),
  };
}
