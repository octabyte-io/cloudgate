import { cloudSqlDefinition } from '../../../../src/cloud-accounts/gcp/definitions/cloud-sql-definition';
import { idKey } from '../../../../src/cloud-accounts/gcp/definitions/names';
import { renderDefinition } from '../../../../src/cloud-accounts/definitions/tofu-json';
import { addresses, resource } from '../../aws/definitions/definition-helpers';

const INPUT = {
  serviceId: 'Svc_Pg',
  cloudAccountId: 'Cloud_Acct-1',
  projectId: 'acme-prod-123',
  region: 'europe-west1',
  environmentId: 'Env_Prod',
  stateId: 'State_Pg-1',
  network: { networkName: 'cloudgate-envkey-net' },
  tier: 'db-custom-1-3840',
  engine: 'postgres' as const,
  databaseVersion: 'POSTGRES_17',
  login: { user: 'pg_1', database: 'app', password: 'not-in-the-file' },
  backupRetentionDays: 7,
  pointInTimeRecovery: true,
};

describe('cloudSqlDefinition', () => {
  const { definition, variables } = cloudSqlDefinition(INPUT);
  const instance = resource(
    definition,
    'google_sql_database_instance.database',
  );
  const settings = instance.settings as Record<string, unknown>;
  const ip = settings.ip_configuration as Record<string, unknown>;
  const ignored = () =>
    (instance.lifecycle as { ignore_changes: string[] }).ignore_changes;

  it('holds the instance, its user and its initial database, and nothing else', () => {
    expect(addresses(definition)).toEqual([
      'google_sql_database.database',
      'google_sql_database_instance.database',
      'google_sql_user.user',
    ]);
  });

  it('names the instance by the Service id’s key, with no random suffix', () => {
    expect(instance.name).toBe(`cloudgate-${idKey('Svc_Pg')}`);
    expect(instance.region).toBe('europe-west1');
  });

  it('is always Enterprise edition, on the machine and version it is given', () => {
    expect(settings.tier).toBe('db-custom-1-3840');
    expect(settings.edition).toBe('ENTERPRISE');
    expect(instance.database_version).toBe('POSTGRES_17');
  });

  it('takes only encrypted connections, with no client certificate, from its own CA, never changed after', () => {
    expect(ip.ssl_mode).toBe('ENCRYPTED_ONLY');
    expect(ip.server_ca_mode).toBe('GOOGLE_MANAGED_INTERNAL_CA');
    expect(ignored()).toContain(
      'settings[0].ip_configuration[0].server_ca_mode',
    );
  });

  it('ignores its activation policy, so an Apply never starts a stopped instance and a plan never counts Stop as a change', () => {
    expect(ignored()).toContain('settings[0].activation_policy');
    // Never set by the definition: Stop and Start are direct calls.
    expect(settings).not.toHaveProperty('activation_policy');
  });

  it('has no public IP, and an automatic PSC connection into the Environment network with automatic DNS', () => {
    expect(ip.ipv4_enabled).toBe(false);
    expect(ip.psc_config).toEqual([
      {
        psc_enabled: true,
        psc_auto_dns_enabled: true,
        allowed_consumer_projects: ['acme-prod-123'],
        psc_auto_connections: [
          {
            consumer_network:
              'projects/acme-prod-123/global/networks/cloudgate-envkey-net',
            consumer_service_project_id: 'acme-prod-123',
          },
        ],
      },
    ]);
  });

  it('is protected from deletion, Google’s protection and the provider’s alike', () => {
    expect(instance.deletion_protection).toBe(true);
    expect(settings.deletion_protection_enabled).toBe(true);
  });

  it('keeps its backups when it is deleted, and never takes Google’s final backup, which expires', () => {
    expect(settings.retain_backups_on_delete).toBe(true);
    expect(settings).not.toHaveProperty('final_backup_config');
    expect(renderDefinition(definition)).not.toContain('final_backup_config');
  });

  it('has both protections off, and nothing else changed, as the definition a Delete applies before its destroy', () => {
    const lifted = cloudSqlDefinition({
      ...INPUT,
      deletionProtectionLifted: true,
    }).definition;
    const liftedInstance = resource(
      lifted,
      'google_sql_database_instance.database',
    );
    const liftedSettings = liftedInstance.settings as Record<string, unknown>;
    expect(liftedInstance.deletion_protection).toBe(false);
    expect(liftedSettings.deletion_protection_enabled).toBe(false);
    expect({
      ...liftedInstance,
      deletion_protection: true,
      settings: { ...liftedSettings, deletion_protection_enabled: true },
    }).toEqual(instance);
  });

  it('takes automated backups kept for the Service’s retention, one a day, with point-in-time recovery on', () => {
    expect(settings.backup_configuration).toEqual({
      enabled: true,
      point_in_time_recovery_enabled: true,
      transaction_log_retention_days: 7,
      backup_retention_settings: {
        retained_backups: 7,
        retention_unit: 'COUNT',
      },
    });

    const kept = (days: number) =>
      (
        resource(
          cloudSqlDefinition({ ...INPUT, backupRetentionDays: days })
            .definition,
          'google_sql_database_instance.database',
        ).settings as Record<string, unknown>
      ).backup_configuration;
    expect(kept(365)).toEqual(
      expect.objectContaining({
        backup_retention_settings: {
          retained_backups: 365,
          retention_unit: 'COUNT',
        },
        transaction_log_retention_days: 7,
      }),
    );
    // Point-in-time recovery never reaches back past the backups kept.
    expect(kept(2)).toEqual(
      expect.objectContaining({ transaction_log_retention_days: 2 }),
    );
  });

  it('keeps automated backups with point-in-time recovery off when it is wanted off', () => {
    const off = resource(
      cloudSqlDefinition({ ...INPUT, pointInTimeRecovery: false }).definition,
      'google_sql_database_instance.database',
    );

    expect(
      (off.settings as Record<string, unknown>).backup_configuration,
    ).toEqual(
      expect.objectContaining({
        enabled: true,
        point_in_time_recovery_enabled: false,
        backup_retention_settings: {
          retained_backups: 7,
          retention_unit: 'COUNT',
        },
      }),
    );
  });

  it('writes no backup setting for an instance made before backups, so its plan leaves it as it is', () => {
    const made = resource(
      cloudSqlDefinition({ ...INPUT, backupRetentionDays: null }).definition,
      'google_sql_database_instance.database',
    );

    expect(made.settings).not.toHaveProperty('backup_configuration');
  });

  it('carries the mark as its labels, Cloud SQL taking no description', () => {
    expect(settings.user_labels).toEqual({
      'cloudgate-cloud-account': idKey('Cloud_Acct-1'),
      'cloudgate-environment': idKey('Env_Prod'),
      'cloudgate-state': idKey('State_Pg-1'),
    });
  });

  it('makes the config’s user and database, the password only as a sensitive variable', () => {
    expect(resource(definition, 'google_sql_user.user')).toEqual(
      expect.objectContaining({
        name: 'pg_1',
        password: '${var.user_password}',
      }),
    );
    expect(resource(definition, 'google_sql_database.database').name).toBe(
      'app',
    );
    expect(variables).toEqual({ user_password: 'not-in-the-file' });
    expect(renderDefinition(definition)).not.toContain('not-in-the-file');
  });

  it('answers its PSC DNS name, never an IP, its own CA as a sensitive output, and its address', () => {
    const output = definition.output as Record<
      string,
      { value: string; sensitive?: boolean }
    >;
    expect(output.dns_name.value).toContain('PRIVATE_SERVICE_CONNECT');
    expect(output.ca).toEqual({
      value: '${google_sql_database_instance.database.server_ca_cert[0].cert}',
      sensitive: true,
    });
    expect(output.private_address.value).toContain('psc_auto_connections');
  });
});

/**
 * A `mysql` on Cloud SQL is the same definition with MySQL's
 * parameters (`CLOUD_SQL_ENGINES`), never a copy of it.
 */
describe('cloudSqlDefinition of a mysql', () => {
  const MYSQL = {
    ...INPUT,
    engine: 'mysql' as const,
    databaseVersion: 'MYSQL_8_4',
    login: {
      user: 'my_1',
      database: 'app',
      password: 'not-in-the-file',
      rootPassword: 'root-not-in-the-file',
    },
  };
  const { definition, variables } = cloudSqlDefinition(MYSQL);
  const instance = resource(
    definition,
    'google_sql_database_instance.database',
  );
  const settings = instance.settings as Record<string, unknown>;
  const ip = settings.ip_configuration as Record<string, unknown>;
  const postgres = resource(
    cloudSqlDefinition(INPUT).definition,
    'google_sql_database_instance.database',
  );

  it('runs the MySQL database_version it is given', () => {
    expect(instance.database_version).toBe('MYSQL_8_4');
  });

  it('offers TLS without requiring it, written rather than left to Google, beside the same pinned CA', () => {
    expect(ip.ssl_mode).toBe('ALLOW_UNENCRYPTED_AND_ENCRYPTED');
    expect(ip.server_ca_mode).toBe('GOOGLE_MANAGED_INTERNAL_CA');
  });

  it("gives root a password of its own, only as a sensitive variable, as the user's is", () => {
    expect(instance.root_password).toBe('${var.root_password}');
    expect(variables).toEqual({
      user_password: 'not-in-the-file',
      root_password: 'root-not-in-the-file',
    });
    expect(definition.variable).toEqual({
      user_password: { type: 'string', sensitive: true, nullable: false },
      root_password: { type: 'string', sensitive: true, nullable: false },
    });
    expect(renderDefinition(definition)).not.toContain('root-not-in-the-file');
  });

  it('turns point-in-time recovery on by its binary log, the argument the pinned provider takes for MySQL', () => {
    expect(settings.backup_configuration).toEqual({
      enabled: true,
      binary_log_enabled: true,
      transaction_log_retention_days: 7,
      backup_retention_settings: {
        retained_backups: 7,
        retention_unit: 'COUNT',
      },
    });
    const off = resource(
      cloudSqlDefinition({ ...MYSQL, pointInTimeRecovery: false }).definition,
      'google_sql_database_instance.database',
    );
    expect(
      (off.settings as { backup_configuration: unknown }).backup_configuration,
    ).toMatchObject({ binary_log_enabled: false });
  });

  it('writes no root password for a postgres, whose definition is as it was', () => {
    expect(postgres).not.toHaveProperty('root_password');
    expect(cloudSqlDefinition(INPUT).variables).toEqual({
      user_password: 'not-in-the-file',
    });
  });

  it('is never made with root open: a mysql with no root password throws', () => {
    expect(() =>
      cloudSqlDefinition({
        ...MYSQL,
        login: { user: 'my_1', database: 'app', password: 'p' },
      }),
    ).toThrow('A mysql on Cloud SQL needs a root password');
  });

  it("is otherwise a postgres's instance: name, edition, machine, network, protection, backups and lifecycle alike", () => {
    const withoutEngine = (made: Record<string, unknown>) => {
      const own = made.settings as Record<string, unknown>;
      const reach = own.ip_configuration as Record<string, unknown>;
      // Each engine's switch for point-in-time recovery, named its own way.
      const backups = {
        ...(own.backup_configuration as Record<string, unknown>),
        point_in_time_recovery_enabled: undefined,
        binary_log_enabled: undefined,
      };
      return {
        ...made,
        database_version: null,
        root_password: null,
        settings: {
          ...own,
          backup_configuration: { ...backups, pointInTimeRecovery: true },
          ip_configuration: { ...reach, ssl_mode: null },
        },
      };
    };
    expect(withoutEngine(instance)).toEqual(withoutEngine(postgres));
  });

  it('makes the config’s user and database, as a postgres’s', () => {
    expect(resource(definition, 'google_sql_user.user')).toEqual(
      expect.objectContaining({
        name: 'my_1',
        password: '${var.user_password}',
      }),
    );
    expect(resource(definition, 'google_sql_database.database').name).toBe(
      'app',
    );
  });
});
