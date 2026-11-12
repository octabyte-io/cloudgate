import {
  GCP_SIZE_BEARING,
  capsWithNativeCloudRun,
  cloudRunWording,
  isGcpSizeBearing,
  nativeCloudRunOf,
  nativeMemorystoreNodeTypeOf,
  nativeTierOf,
} from '../../src/native/gcp-size';
import { GCP_OPEN_SETTINGS } from '../../src/native/google-open-settings';
import { nativeSizesOf } from '../../src/native/size-override';
import { cloudSqlTierText } from '../../src/project-config/planner/cloud-sql';

/**
 * ADR-0044 rule 12: exact sizes on Google Cloud. A native Cloud
 * SQL tier, Memorystore node type or Cloud Run limit wins over `size` on
 * Google Cloud, and the size line names both, by the rules AWS's read
 * (`size-override.ts`).
 */
const SQL = 'google_sql_database_instance.database';
const CACHE = 'google_memorystore_instance.cache';
const RUN = 'google_cloud_run_v2_service.service';

describe('GCP_SIZE_BEARING', () => {
  it('are each open on the lock list, so native can set them', () => {
    // A map attribute is open by its own path; its keys are its values.
    const shut = GCP_SIZE_BEARING.settings
      .map((one) => ({
        ...one,
        key: (one.path.at(-2) === 'limits'
          ? one.path.slice(0, -1)
          : one.path
        ).join('.'),
      }))
      .filter(
        (one) => !(GCP_OPEN_SETTINGS[one.address] ?? []).includes(one.key),
      )
      .map((one) => `${one.address}.${one.key}`);
    expect(shut).toEqual([]);
  });

  it('reads what a block sets, by its path in the file, a block of one written either way', () => {
    const block = {
      [SQL]: { settings: [{ tier: 'db-perf-optimized-N-4' }] },
      [CACHE]: { node_type: 'HIGHMEM_XLARGE' },
      [RUN]: {
        template: {
          containers: { resources: { limits: { memory: '8Gi' } } },
        },
      },
    };

    expect(nativeSizesOf(GCP_SIZE_BEARING, block)).toEqual([
      {
        part: 'machine',
        address: SQL,
        value: 'db-perf-optimized-N-4',
        path: `native.gcp."${SQL}".settings.tier`,
      },
      {
        part: 'machine',
        address: CACHE,
        value: 'HIGHMEM_XLARGE',
        path: `native.gcp."${CACHE}".node_type`,
      },
      {
        part: 'memory',
        address: RUN,
        value: '8Gi',
        path: `native.gcp."${RUN}".template.containers.resources.limits.memory`,
      },
    ]);
    expect(nativeTierOf(block)).toBe('db-perf-optimized-N-4');
    expect(nativeMemorystoreNodeTypeOf(block)).toBe('HIGHMEM_XLARGE');
    expect(nativeCloudRunOf(block)).toEqual({ memoryMb: 8192 });
    expect(nativeTierOf(undefined)).toBeNull();
    expect(
      isGcpSizeBearing(RUN, [
        'template',
        'containers',
        'resources',
        'limits',
        'cpu',
      ]),
    ).toBe(true);
    expect(isGcpSizeBearing(SQL, ['settings', 'disk_size'])).toBe(false);
  });

  it("reads a Cloud Run cpu in Google's spellings", () => {
    const cpu = (value: unknown) =>
      nativeCloudRunOf({
        [RUN]: {
          template: { containers: { resources: { limits: { cpu: value } } } },
        },
      }).cpu;
    expect([cpu('2'), cpu(4), cpu('500m'), cpu('two')]).toEqual([
      2,
      4,
      0.5,
      undefined,
    ]);
  });

  it('words a pair native sets in part, each native half marked', () => {
    const block = {
      [RUN]: {
        template: { containers: { resources: { limits: { cpu: '4' } } } },
      },
    };
    expect(cloudRunWording({ cpu: 1, memoryMb: 2048 }, block)).toBe(
      '4 CPU (native) / 2 GB',
    );
    expect(capsWithNativeCloudRun({ cpu: 1, memoryMb: 512 }, block)).toEqual({
      cpuLimit: String(4e9),
      memoryLimit: String(512 * 1024 * 1024),
    });
    expect(capsWithNativeCloudRun({ cpu: 1, memoryMb: 512 }, {})).toBeNull();
  });

  it('names a tier with its CPU and memory when the committed table knows it', () => {
    expect(cloudSqlTierText('db-perf-optimized-N-4')).toBe('4 vCPU, 32 GB');
    expect(cloudSqlTierText('db-n1-standard-2')).toBe('2 vCPU, 7.5 GB');
    expect(cloudSqlTierText('db-custom-2-7680')).toBe('2 vCPU, 7.5 GB');
    expect(cloudSqlTierText('db-g1-small')).toBe('shared CPU, 1.7 GB, no SLA');
    expect(cloudSqlTierText('db-memory-optimized-N-4')).toBeNull();
  });
});
