import { cloudSqlDefinition } from '../../../../src/cloud-accounts/gcp/definitions/cloud-sql-definition';
import { memorystoreDefinition } from '../../../../src/cloud-accounts/gcp/definitions/memorystore-definition';
import { resource } from '../../aws/definitions/definition-helpers';

/**
 * ADR-0044 rule 3: a postgres's Cloud SQL definition and a redis's
 * Memorystore one lay their `native.gcp` over what Cloudgate writes, by the
 * committed provider schema: Cloud SQL's `settings` field by field, its
 * `database_flags` whole; Memorystore's `engine_configs` key by key.
 * Cloudgate's own `lifecycle` stays.
 */
const PLACE = {
  serviceId: 'Svc_Db',
  cloudAccountId: 'Cloud_Acct-1',
  projectId: 'acme-prod-123',
  region: 'europe-west1',
  environmentId: 'Env_Prod',
  stateId: 'State_Db-1',
  network: { networkName: 'cloudgate-envkey-net' },
};

const SQL = {
  ...PLACE,
  tier: 'db-custom-1-3840',
  engine: 'postgres' as const,
  databaseVersion: 'POSTGRES_17',
  login: { user: 'pg_1', database: 'app', password: 'not-in-the-file' },
  backupRetentionDays: 7,
  pointInTimeRecovery: true,
};

const INSTANCE = 'google_sql_database_instance.database';
const CACHE = 'google_memorystore_instance.cache';

const sqlInstance = (native?: Record<string, Record<string, unknown>>) =>
  resource(cloudSqlDefinition({ ...SQL, native }).definition, INSTANCE);

describe('cloudSqlDefinition with native.gcp', () => {
  const ours = sqlInstance();
  const settings = (instance: Record<string, unknown>) =>
    instance.settings as Record<string, unknown>;

  it('writes exactly Cloudgate’s definition with no block', () => {
    expect(sqlInstance(undefined)).toEqual(ours);
    expect(sqlInstance({})).toEqual(ours);
  });

  it('merges settings field by field, keeping Cloudgate’s tier, edition, network and labels', () => {
    const laid = sqlInstance({
      [INSTANCE]: {
        settings: {
          maintenance_window: { day: 7, hour: 3 },
          insights_config: { query_insights_enabled: true },
        },
      },
    });

    expect(settings(laid)).toEqual({
      ...settings(ours),
      maintenance_window: { day: 7, hour: 3 },
      insights_config: { query_insights_enabled: true },
    });
  });

  it('replaces database_flags whole, as written, never appended to', () => {
    const flags = [
      { name: 'log_min_duration_statement', value: '250' },
      { name: 'max_connections', value: '200' },
    ];
    const laid = sqlInstance({
      [INSTANCE]: { settings: { database_flags: flags } },
    });

    expect(settings(laid).database_flags).toEqual(flags);
  });

  it('merges backup_configuration field by field, so turning point-in-time recovery off keeps the backups', () => {
    const laid = sqlInstance({
      [INSTANCE]: {
        settings: {
          backup_configuration: { point_in_time_recovery_enabled: false },
        },
      },
    });

    expect(settings(laid).backup_configuration).toEqual({
      ...(settings(ours).backup_configuration as object),
      point_in_time_recovery_enabled: false,
    });
  });

  it('keeps Cloudgate’s lifecycle and its deletion protection', () => {
    const laid = sqlInstance({
      [INSTANCE]: { settings: { disk_autoresize: false } },
    });

    expect(laid.lifecycle).toEqual(ours.lifecycle);
    expect(laid.deletion_protection).toBe(true);
    expect(settings(laid).deletion_protection_enabled).toBe(true);
  });
});

describe('memorystoreDefinition with native.gcp', () => {
  const MEMORYSTORE = {
    ...PLACE,
    nodeType: 'CUSTOM_MICRO',
    engineVersion: 'VALKEY_8_0',
    highAvailability: false,
    backupRetentionDays: 1,
  };
  const cache = (native?: Record<string, Record<string, unknown>>) =>
    resource(memorystoreDefinition({ ...MEMORYSTORE, native }), CACHE);
  const ours = cache();

  it('writes exactly Cloudgate’s definition with no block', () => {
    expect(cache(null as never)).toEqual(ours);
  });

  it('sets maxmemory-policy key by key, keeping every other engine_configs key', () => {
    const laid = cache({
      [CACHE]: {
        engine_configs: {
          'maxmemory-policy': 'allkeys-lru',
          'maxmemory-clients': '10%',
        },
      },
    });

    expect(laid.engine_configs).toEqual({
      'maxmemory-policy': 'allkeys-lru',
      'maxmemory-clients': '10%',
    });
    // A key it does not set is Cloudgate's, as Cloudgate wrote it.
    expect(
      cache({ [CACHE]: { engine_configs: { 'maxmemory-clients': '10%' } } })
        .engine_configs,
    ).toEqual({ 'maxmemory-policy': 'noeviction', 'maxmemory-clients': '10%' });
  });

  it('lets replica_count win over the console’s high availability', () => {
    expect(cache({ [CACHE]: { replica_count: 2 } }).replica_count).toBe(2);
  });

  it('keeps its provider and Cloudgate’s lifecycle', () => {
    const laid = cache({ [CACHE]: { replica_count: 1 } });

    expect(laid.provider).toBe(ours.provider);
    expect(laid.lifecycle).toEqual(ours.lifecycle);
  });
});
