import type { CloudKind } from '../../cloud-accounts/cloud-account.schema';
import { valkeyRegistrationView } from '../../project-config/existing-valkey-status';
import type { ValkeyRegistrationView } from '../../project-config/existing-valkey-status';
import type { ExistingDatabase } from '../postgres/existing-database.schema';
import { notFoundSentence } from '../postgres/existing-postgres';

/**
 * What an Existing database that is a redis reads with: where it is,
 * its TLS flag and the operator's tick. Its AUTH token is never here: the
 * row it sits beside answers `hasAuthToken` in its place (ADR-0019).
 */
export interface ExistingCacheView {
  readonly identifier: string;
  readonly cloudAccountId: string;
  readonly region: string;
  readonly madeReachable: boolean;
  /** TLS on: `rediss://` with a `ca`; off: `redis://` with none. */
  readonly tls: boolean;
  /** Where the last plan's lookup found it, `null` until one has. */
  readonly address: { readonly host: string; readonly port: number } | null;
  /** The last plan found nothing under its id: "AWS cannot find" it. */
  readonly notFound: {
    readonly sentence: string;
    readonly since: string;
  } | null;
  /**
   * On Google Cloud, once Cloudgate's two endpoints are made:
   * whether the operator has registered them on the instance, and while
   * they wait the exact `--add-endpoints` command. `null` before, and on
   * AWS.
   */
  readonly registration: ValkeyRegistrationView | null;
}

/**
 * An existing cache as its page reads it. `google` is the Environment's
 * Google Cloud project and the Environment, for an existing Valkey's
 * registration command; `null` on AWS.
 */
export function existingCacheView(
  existing: ExistingDatabase,
  cloud: CloudKind | null = null,
  google: {
    readonly projectId: string;
    readonly environmentId: string;
  } | null = null,
): ExistingCacheView {
  return {
    identifier: existing.identifier,
    cloudAccountId: existing.cloudAccountId,
    region: existing.region,
    madeReachable: existing.madeReachable,
    tls: existing.tls,
    address: existing.address ?? null,
    notFound: existing.notFoundAt
      ? {
          sentence: notFoundSentence(existing.identifier, cloud),
          since: existing.notFoundAt,
        }
      : null,
    registration: google ? valkeyRegistrationView(existing, google) : null,
  };
}

/**
 * The Outputs an edit of an Existing cache changes, so the Services
 * linking them read "deploy to pick up the new value": a new AUTH
 * token changes `url` and `password`, a new TLS flag `url` and `ca`, a new
 * replication group every one (its address is the next lookup's).
 */
export function cacheOutputsChanged(change: {
  readonly token: boolean;
  readonly tls: boolean;
  readonly identifier: boolean;
}): string[] {
  const changed = new Set<string>();
  if (change.token) ['url', 'password'].forEach((one) => changed.add(one));
  if (change.tls) ['url', 'ca'].forEach((one) => changed.add(one));
  if (change.identifier) {
    ['url', 'host', 'port'].forEach((one) => changed.add(one));
  }
  return ['url', 'host', 'port', 'password', 'ca'].filter((one) =>
    changed.has(one),
  );
}
