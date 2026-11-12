import {
  cloudSqlNativeColumns,
  gcpConsoleRefusalOf,
  GCP_CONSOLE_OWNED,
  isGcpConsoleOwned,
  memorystoreNativeColumns,
} from '../../src/native/gcp-console-owned';
import { GCP_OPEN_SETTINGS } from '../../src/native/google-open-settings';

/**
 * ADR-0044 rule 10: the settings the console owned before native,
 * on Google Cloud. Native wins and its Apply writes the console's column,
 * the Database page and Backups tab refuse one native sets, and a key
 * taken out leaves the column as it is.
 */
const INSTANCE = 'google_sql_database_instance.database';
const CACHE = 'google_memorystore_instance.cache';

describe('cloudSqlNativeColumns', () => {
  it("writes a native backup count to the Backups tab's column beside the block", () => {
    const block = {
      [INSTANCE]: {
        settings: {
          backup_configuration: {
            backup_retention_settings: { retained_backups: 14 },
          },
          disk_autoresize: false,
        },
      },
    };

    expect(cloudSqlNativeColumns(block)).toEqual({
      nativeGcp: block,
      backupRetentionDays: 14,
    });
  });

  it('reads a block written as a list of one, as the provider takes it', () => {
    expect(
      cloudSqlNativeColumns({
        [INSTANCE]: {
          settings: [
            {
              backup_configuration: [
                { backup_retention_settings: [{ retained_backups: 3 }] },
              ],
            },
          ],
        },
      }).backupRetentionDays,
    ).toBe(3);
  });

  it('writes the block alone once the key is taken out, so the column stays where it is', () => {
    expect(cloudSqlNativeColumns(undefined)).toEqual({ nativeGcp: null });
    expect(
      cloudSqlNativeColumns({ [INSTANCE]: { settings: { disk_size: 50 } } }),
    ).not.toHaveProperty('backupRetentionDays');
  });
});

describe('memorystoreNativeColumns', () => {
  it('reads high availability as one replica or more, and backup days from the retention', () => {
    expect(
      memorystoreNativeColumns({
        [CACHE]: {
          replica_count: 2,
          automated_backup_config: { retention: '259200s' },
        },
      }),
    ).toEqual({
      nativeGcp: expect.any(Object) as object,
      memorystoreHighAvailability: true,
      memorystoreBackupRetentionDays: 3,
    });
    expect(
      memorystoreNativeColumns({ [CACHE]: { replica_count: 0 } })
        .memorystoreHighAvailability,
    ).toBe(false);
  });

  it('writes no backup days for a retention that is not whole days', () => {
    expect(
      memorystoreNativeColumns({
        [CACHE]: { automated_backup_config: { retention: '3600s' } },
      }),
    ).not.toHaveProperty('memorystoreBackupRetentionDays');
  });
});

describe('gcpConsoleRefusalOf', () => {
  it('refuses a change to replica_count native sets, naming the path, and lets any other through', () => {
    const block = { [CACHE]: { replica_count: 1 } };

    expect(gcpConsoleRefusalOf('redis', block, ['highAvailability'])).toBe(
      `highAvailability is set by redis.native.gcp."${CACHE}".replica_count in the Project config, which owns it while it sets it; change it there, or take the key out to hand it back to this page`,
    );
    expect(
      gcpConsoleRefusalOf('redis', block, ['backupRetentionDays']),
    ).toBeNull();
    expect(gcpConsoleRefusalOf('redis', null, ['highAvailability'])).toBeNull();
  });

  it("refuses the Backups tab's count on Cloud SQL while native sets it", () => {
    expect(
      gcpConsoleRefusalOf(
        'pg-1',
        {
          [INSTANCE]: {
            settings: {
              backup_configuration: {
                backup_retention_settings: { retained_backups: 14 },
              },
            },
          },
        },
        ['backupRetentionDays'],
      ),
    ).toContain(
      `backupRetentionDays is set by pg-1.native.gcp."${INSTANCE}".settings.backup_configuration.backup_retention_settings.retained_backups`,
    );
  });
});

describe('isGcpConsoleOwned', () => {
  it('knows a console-owned leaf by its path, and nothing beside it', () => {
    expect(isGcpConsoleOwned(CACHE, ['replica_count'])).toBe(true);
    expect(isGcpConsoleOwned(CACHE, ['node_type'])).toBe(false);
    expect(isGcpConsoleOwned(INSTANCE, ['replica_count'])).toBe(false);
  });
});

describe('GCP_CONSOLE_OWNED in the census', () => {
  it('classes every one open, so native can set what the console owned', () => {
    const shut = Object.entries(GCP_CONSOLE_OWNED).flatMap(([address, keys]) =>
      Object.keys(keys)
        .filter((key) => !(GCP_OPEN_SETTINGS[address] ?? []).includes(key))
        .map((key) => `${address}.${key}`),
    );
    expect(shut).toEqual([]);
  });
});
