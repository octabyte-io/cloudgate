import {
  blameNativeGcp,
  closesRunApp,
  laysNativeGcp,
  nativeGcpReplaceRefusals,
  storedNativeGcpRefusal,
} from '../../src/native/gcp-lay';
import { GCP_NOT_LAID } from '../../src/native/google-locks';
import { kindsOn } from '../../src/project-config/planner/plan-environment';
import type { ConfigKind } from '../../src/project-config/planner/plan.types';

/**
 * ADR-0044 rules 5 and 9: what a deploy does with a Service's
 * stored `native.gcp`: a value locked since it was applied fails the
 * Deployment naming it, a value only Google can judge names its path, and
 * a closed `run.app` address is known by its ingress.
 */
const RUN = 'google_cloud_run_v2_service.service';

describe('laysNativeGcp', () => {
  it('lays on every kind Google Cloud makes but those it refuses as not laid yet', () => {
    expect(
      [...kindsOn('gcp')].filter(
        (kind) => laysNativeGcp(kind) === Object.hasOwn(GCP_NOT_LAID, kind),
      ),
    ).toEqual([]);
    expect(
      Object.keys(GCP_NOT_LAID).filter(
        (kind) => !kindsOn('gcp').has(kind as ConfigKind),
      ),
    ).toEqual([]);
  });

  it('lays on a web, a postgres and a redis, and on no other kind yet', () => {
    expect(['web', 'postgres', 'redis'].map(laysNativeGcp)).toEqual([
      true,
      true,
      true,
    ]);
    // A Private web service's settings are slice 8's, as a
    // Worker's and a Cron service's are.
    expect(
      ['web-private', 'worker', 'cron', 'static'].map(laysNativeGcp),
    ).toEqual([false, false, false, false]);
  });
});

describe('storedNativeGcpRefusal', () => {
  it('passes a stored block with nothing locked, and none at all', () => {
    expect(
      storedNativeGcpRefusal('api', 'web', {
        [RUN]: { template: { timeout: '120s' } },
      }),
    ).toBeNull();
    expect(storedNativeGcpRefusal('api', 'web', null)).toBeNull();
  });

  it('refuses a stored block holding a locked value, naming it, never stripping it', () => {
    expect(
      storedNativeGcpRefusal('api', 'web', {
        [RUN]: {
          template: { timeout: '120s' },
          ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY',
        },
      }),
    ).toMatch(
      /^This Service's stored native\.gcp is refused, so nothing was changed: api\.native\.gcp\."google_cloud_run_v2_service\.service"\.ingress: refused - locked: .+\. Correct the Project config and apply its plan$/,
    );
  });
});

describe('blameNativeGcp', () => {
  it('names the native path Google refused, in the provider’s spelling or Google’s', () => {
    const stored = {
      [RUN]: { template: { max_instance_request_concurrency: 5000 } },
    };
    const message =
      'Error 400: spec.template.spec.containerConcurrency: maxInstanceRequestConcurrency must be at most 1000';
    expect(blameNativeGcp(message, stored)).toBe(
      `Google Cloud refused this Service's native.gcp."${RUN}".template.max_instance_request_concurrency: ${message}`,
    );
  });

  it('leaves a refusal that names no native path as Google wrote it', () => {
    const message = 'Error 403: Permission denied';
    expect(
      blameNativeGcp(message, { [RUN]: { template: { timeout: '120s' } } }),
    ).toBe(message);
    expect(blameNativeGcp(message, null)).toBe(message);
  });
});

describe('closesRunApp', () => {
  it('knows a block closes the run.app address by its ingress', () => {
    expect(
      closesRunApp({
        [RUN]: { ingress: 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER' },
      }),
    ).toBe(true);
    expect(closesRunApp({ [RUN]: { ingress: 'INGRESS_TRAFFIC_ALL' } })).toBe(
      false,
    );
    expect(closesRunApp({ [RUN]: { template: { timeout: '120s' } } })).toBe(
      false,
    );
    expect(closesRunApp(null)).toBe(false);
  });
});

/**
 * ADR-0044 rules 9 and 10: a postgres's Cloud SQL instance and a
 * redis's Memorystore instance hold data, so a native change Google's plan
 * carries out as a replace of either is refused naming the path, by the
 * one rule AWS reads; and a stored block holding a locked value fails
 * their Cloud run as a web's does.
 */
describe('nativeGcpReplaceRefusals and storedNativeGcpRefusal on Cloud SQL and Memorystore', () => {
  const INSTANCE = 'google_sql_database_instance.database';
  const CACHE = 'google_memorystore_instance.cache';
  const block = {
    [INSTANCE]: {
      encryption_key_name: 'projects/p/locations/l/keyRings/r/cryptoKeys/k',
      settings: { disk_type: 'PD_HDD', maintenance_window: { day: 7 } },
    },
  };
  const replaced = {
    address: INSTANCE,
    action: 'replace',
    fields: ['settings'],
  };

  it('refuses the native paths whose change replaces the Cloud SQL instance, and only them', () => {
    expect(nativeGcpReplaceRefusals('pg-1', block, [replaced])).toEqual([
      {
        at: `pg-1.native.gcp."${INSTANCE}".settings.disk_type`,
        message: `pg-1.native.gcp."${INSTANCE}".settings.disk_type: refused - OpenTofu would replace the Cloud SQL instance for it, deleting the data it holds (set it back, or move the data to a new Service yourself)`,
      },
      {
        at: `pg-1.native.gcp."${INSTANCE}".settings.maintenance_window.day`,
        message: expect.stringContaining(
          'refused - OpenTofu would replace the Cloud SQL instance',
        ) as string,
      },
    ]);
  });

  it('names every path the block sets on a replace whose read names no argument', () => {
    expect(
      nativeGcpReplaceRefusals('redis', { [CACHE]: { kms_key: 'k' } }, [
        { address: CACHE, action: 'replace', fields: [] },
      ]).map((one) => one.message),
    ).toEqual([
      `redis.native.gcp."${CACHE}".kms_key: refused - OpenTofu would replace the Memorystore instance for it, deleting the data it holds (set it back, or move the data to a new Service yourself)`,
    ]);
  });

  it('refuses nothing for an in-place change, a replace native did not force, or no block', () => {
    expect(
      nativeGcpReplaceRefusals('pg-1', block, [
        { ...replaced, action: 'change' },
        { ...replaced, fields: ['database_version'] },
      ]),
    ).toEqual([]);
    expect(nativeGcpReplaceRefusals('pg-1', null, [replaced])).toEqual([]);
  });

  it('refuses a stored block holding a locked value on a postgres and a redis', () => {
    expect(
      storedNativeGcpRefusal('pg-1', 'postgres', {
        [INSTANCE]: { settings: { ip_configuration: { ipv4_enabled: true } } },
      }),
    ).toContain(`pg-1.native.gcp."${INSTANCE}".settings.ip_configuration`);
    expect(
      storedNativeGcpRefusal('redis', 'redis', {
        [CACHE]: { engine_configs: { 'maxmemory-policy': 'allkeys-lru' } },
      }),
    ).toBeNull();
  });
});
