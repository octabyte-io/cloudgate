import {
  GCP_ADDRESSES,
  GCP_CONTAINER_ADDRESS,
  GCP_CONTAINER_LOCKS,
  GCP_CONTAINER_PATH,
  GCP_LOCKED_EVERYWHERE,
  GCP_PER_INSTANCE,
} from '../../src/native/google-locks';
import {
  gcpAddressEntry,
  gcpAddressesMade,
  nativeGcpCheck,
} from '../../src/native/gcp-native';
import { blockAt, committedProvider } from '../../src/native/provider-schema';
import type { SchemaBlock } from '../../src/native/provider-schema';

/**
 * The Google lock table behind `native.gcp`, held to the committed
 * `hashicorp/google` schema. The planner's own
 * spec (`plan-environment-native-gcp`) drives refusals through a plan; this
 * one checks that every lock names a real argument of the provider its
 * address is checked against, so a misspelt lock can never leave the
 * argument it meant open.
 */

/** Whether `path` names an argument or block of `block`. */
function names(block: SchemaBlock, path: readonly string[]): boolean {
  const [head, ...rest] = path;
  if (rest.length === 0) {
    return (
      head in (block.attributes ?? {}) || head in (block.block_types ?? {})
    );
  }
  const nested = block.block_types?.[head];
  return nested !== undefined && names(nested.block, rest);
}

describe('GCP_ADDRESSES', () => {
  it.each(Object.entries(GCP_ADDRESSES))(
    '%s is a committed type of its provider, and each argument it locks is one of that type',
    (_address, entry) => {
      const block = committedProvider(entry.provider).resource(entry.type);
      expect(block).toBeDefined();
      const missing = [
        ...Object.keys(entry.locked ?? {}),
        ...Object.keys(entry.limited ?? {}),
      ].filter((path) => !names(block!, path.split('.')));
      expect(missing).toEqual([]);
    },
  );

  it('checks every address against google, Memorystore included', () => {
    expect(
      Object.entries(GCP_ADDRESSES)
        .filter(([, entry]) => entry.provider !== 'google')
        .map(([address]) => address),
    ).toEqual([]);
    expect(GCP_ADDRESSES['google_memorystore_instance.cache'].provider).toBe(
      'google',
    );
  });

  it('locks on every address only arguments some address has', () => {
    const unused = Object.keys(GCP_LOCKED_EVERYWHERE).filter(
      (key) =>
        !Object.values(GCP_ADDRESSES).some((entry) =>
          names(committedProvider(entry.provider).resource(entry.type)!, [key]),
        ),
    );
    expect(unused).toEqual([]);
  });

  it('locks only arguments of the Cloud Run container', () => {
    const entry = GCP_ADDRESSES[GCP_CONTAINER_ADDRESS];
    const container = blockAt(
      committedProvider(entry.provider),
      entry.type,
      GCP_CONTAINER_PATH,
    );
    expect(container).toBeDefined();
    expect(
      Object.keys(GCP_CONTAINER_LOCKS).filter(
        (key) => !names(container!, [key]),
      ),
    ).toEqual([]);
  });

  it('names no address both as made once and as made per Domain or variable', () => {
    expect(
      Object.keys(GCP_PER_INSTANCE).filter(
        (address) => address in GCP_ADDRESSES,
      ),
    ).toEqual([]);
  });
});

describe('gcpAddressesMade', () => {
  it.each([
    [
      'web',
      [
        'google_artifact_registry_repository.service',
        'google_service_account.service',
        'google_cloud_run_v2_service.service',
        'google_compute_region_network_endpoint_group.service',
        'google_compute_backend_service.service',
      ],
    ],
    [
      'web-private',
      [
        'google_artifact_registry_repository.service',
        'google_service_account.service',
        'google_cloud_run_v2_service.service',
      ],
    ],
    [
      'postgres',
      [
        'google_sql_database_instance.database',
        'google_sql_database.database',
        'google_sql_user.user',
      ],
    ],
    ['redis', ['google_memorystore_instance.cache']],
    [
      'worker',
      [
        'google_artifact_registry_repository.service',
        'google_service_account.service',
        'google_cloud_run_v2_worker_pool.service',
      ],
    ],
    [
      'cron',
      [
        'google_artifact_registry_repository.service',
        'google_service_account.service',
        'google_cloud_run_v2_job.service',
      ],
    ],
    [
      'bucket',
      [
        'google_storage_bucket.bucket',
        'google_storage_bucket_iam_member.object_user',
        'google_service_account.bucket',
        'google_storage_hmac_key.key',
        'google_storage_hmac_key.key_b',
      ],
    ],
    [
      'static',
      [
        'google_storage_bucket.site',
        'google_compute_backend_bucket.site',
        'google_storage_bucket_iam_member.load_balancer',
      ],
    ],
    // A mysql on Cloud SQL: a postgres's addresses.
    [
      'mysql',
      [
        'google_sql_database_instance.database',
        'google_sql_database.database',
        'google_sql_user.user',
      ],
    ],
  ] as const)(
    'a %s may name what the native list holds for it, and the census found',
    (kind, made) => {
      expect(gcpAddressesMade(kind, {})).toEqual(made);
    },
  );

  it.each(['postgres', 'mysql'] as const)(
    'makes only its endpoint of an Existing database, a %s',
    (kind) => {
      expect(gcpAddressesMade(kind, { existing: true })).toEqual([
        'google_compute_address.endpoint',
        'google_compute_forwarding_rule.endpoint',
        'google_dns_managed_zone.instance',
        'google_dns_record_set.instance',
      ]);
    },
  );

  it('makes only its own account and key of an existing bucket', () => {
    expect(gcpAddressesMade('bucket', { existing: true })).toEqual([
      'google_service_account.bucket',
      'google_storage_hmac_key.key',
      'google_storage_hmac_key.key_b',
    ]);
  });
});

describe('gcpAddressEntry', () => {
  it('reads an address only for a kind that makes it', () => {
    expect(
      gcpAddressEntry('web', 'google_compute_backend_service.service'),
    ).toBeDefined();
    expect(
      gcpAddressEntry('web-private', 'google_compute_backend_service.service'),
    ).toBeUndefined();
  });

  it('does not read a table’s inherited keys as addresses', () => {
    expect(gcpAddressEntry('web', 'constructor')).toBeUndefined();
  });
});

describe('nativeGcpCheck', () => {
  it('does not read a table’s inherited keys as locks or addresses', () => {
    expect(
      nativeGcpCheck(
        'api',
        'web',
        {
          'google_cloud_run_v2_service.service': {
            template: { containers: { toString: 'x' } },
          },
          'toString.service': {},
        },
        {},
      ).refusals.map((refusal) => refusal.at),
    ).toEqual([
      'api.native.gcp."google_cloud_run_v2_service.service".template.containers.toString',
      'api.native.gcp."toString.service"',
    ]);
  });

  it('refuses a key that is not an address, naming the form one takes', () => {
    expect(nativeGcpCheck('api', 'web', { service: {} }, {}).refusals).toEqual([
      {
        at: 'api.native.gcp."service"',
        message:
          'api.native.gcp."service": refused - an address is <type>.<name>, as the plan’s cloud lines show it',
      },
    ]);
  });
});
