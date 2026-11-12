import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanOutcome,
  SavedService,
} from '../../src/project-config';
import { kindsOn } from '../../src/project-config/planner/plan-environment';

/**
 * A `mysql` on a Google Cloud Deploy target is a Cloud SQL for MySQL
 * instance, planned by `postgres` on Cloud SQL's rules with MySQL's
 * parameters (`CLOUD_SQL_ENGINES`): 8.4 alone, `root` and a user over 32
 * characters refused, and point-in-time recovery's restart mark in MySQL's
 * words, once each way.
 */

const GOOGLE: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'gca-1',
  region: 'europe-west1',
};

function plan(text: string, saved: SavedService[] = []): PlanOutcome {
  const parsed = parseProjectConfig(text);
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal.message}`);
  return planEnvironment({
    config: parsed.config,
    saved,
    deployTarget: GOOGLE,
    cloud: 'gcp',
    context: { previous: null },
    networks: [{ cloudAccountId: 'gca-1', region: 'europe-west1' }],
  });
}

function planned(...args: Parameters<typeof plan>) {
  const outcome = plan(...args);
  if (!outcome.ok) {
    throw new Error(
      `refused: ${outcome.refusals.map((r) => r.message).join('; ')}`,
    );
  }
  return outcome;
}

function refusals(...args: Parameters<typeof plan>) {
  const outcome = plan(...args);
  if (outcome.ok) throw new Error('planned, but a refusal was expected');
  return outcome.refusals;
}

const entry = (lines = '') =>
  `version: 1\nservices:\n  db-1:\n    kind: mysql\n${lines}`;

/** The one create step a plan of `entry(lines)` makes. */
function created(lines = '') {
  const step = planned(entry(lines)).steps.find(
    (one) => one.action === 'create',
  );
  if (!step || step.action !== 'create') throw new Error('no create');
  return step;
}

/** A mysql already made on Cloud SQL, its last Apply's point-in-time recovery as given. */
function onCloudSql(
  pointInTimeRecovery: boolean,
): Extract<SavedService, { serviceType: 'mysql' }> {
  return {
    serviceType: 'mysql',
    serviceId: 'my-id',
    name: 'db-1',
    configName: 'db-1',
    cloud: {
      cloudAccountId: 'gca-1',
      region: 'europe-west1',
      cloud: 'gcp',
      linkedRegistries: [],
    },
    cloudSql: {
      backupRetentionDays: 7,
      applied: { backupRetentionDays: 7, pointInTimeRecovery },
      tier: 'db-f1-micro',
    },
    settings: {
      description: null,
      cpuLimit: null,
      memoryLimit: null,
      dockerImage: 'mysql:8.4',
      databaseName: 'db_1',
      databaseUser: 'db_1',
    },
    variables: { env: [] },
  };
}

describe('planEnvironment, a mysql on a Google Cloud Deploy target', () => {
  it('is a kind Google Cloud makes, the last database kind, with only compose (ADR-0070) after it', () => {
    expect(kindsOn('gcp').has('mysql')).toBe(true);
    expect([...kindsOn('gcp')].slice(-2)).toEqual(['mysql', 'compose']);
  });

  it('creates a Cloud SQL instance on the machine its size gives, read from Google Cloud, never through RDS', () => {
    const step = created('    size: medium\n');

    expect(step.database).toBeUndefined();
    expect(step.cloudSql?.size).toEqual({
      name: 'medium',
      tier: 'db-custom-1-3840',
      machine: '1 vCPU, 3.75 GB',
      smallest: false,
    });
    expect(step.cloudRead).toEqual({ status: 'reading' });
  });

  describe('version', () => {
    it("with no version is MySQL 8.4, Cloud SQL's MYSQL_8_4", () => {
      expect(created().cloudSql?.version).toEqual({
        written: '8.4',
        major: 8.4,
        databaseVersion: 'MYSQL_8_4',
      });
    });

    it('takes "8.4" as MYSQL_8_4', () => {
      expect(created('    version: "8.4"\n').cloudSql?.version).toMatchObject({
        databaseVersion: 'MYSQL_8_4',
      });
    });

    it.each([
      [
        '9.7',
        'db-1.version: MySQL 9.7 is not offered on Cloud SQL by Cloudgate, which offers there the MySQL majors it offers on RDS, 8.4 alone; write "8.4"',
      ],
      [
        '8.0',
        'db-1.version: MySQL 8.0 enters paid extended support on Cloud SQL on 1 January 2027, and Cloudgate refuses it on RDS too, so it never chooses it for you; write "8.4"',
      ],
      [
        '8.4.6',
        'db-1.version: 8.4.6 pins a MySQL minor, which Cloud SQL cannot: it offers MySQL 8.4 with no pinned minor and moves its minors itself; write "8.4"',
      ],
    ])('refuses "%s" by name, suggesting "8.4"', (version, message) => {
      expect(refusals(entry(`    version: "${version}"\n`))).toEqual([
        { at: 'db-1.version', message },
      ]);
    });
  });

  describe('login', () => {
    it('makes the Server’s default user and database when the entry names neither', () => {
      expect(created().cloudSql?.login).toEqual({
        user: 'db_1',
        database: 'db_1',
      });
    });

    it('refuses user: root by name', () => {
      expect(refusals(entry('    user: root\n'))).toEqual([
        {
          at: 'db-1.user',
          message:
            "db-1.user: Cloud SQL refuses root as a MySQL app user; root is a Server's only, and Cloudgate gives Cloud SQL's own root a password of its own, so choose another user:",
        },
      ]);
    });

    it('refuses a user over 32 characters as the config is read, and takes one of 32', () => {
      const parsed = parseProjectConfig(entry(`    user: ${'a'.repeat(33)}\n`));

      expect(parsed.ok || parsed.refusal.message).toBe(
        "db-1.user is longer than MySQL's 32 characters; write a shorter user:",
      );
      expect(
        created(`    user: ${'a'.repeat(32)}\n`).cloudSql?.login.user,
      ).toBe('a'.repeat(32));
    });

    it('refuses the default user of a Config name over 32 characters as the config is read', () => {
      const name = `db-${'a'.repeat(30)}`;
      const parsed = parseProjectConfig(
        `version: 1\nservices:\n  ${name}:\n    kind: mysql\n`,
      );

      expect(parsed.ok || parsed.refusal.message).toBe(
        `${name}.user: with no user, it would be ${name.replaceAll('-', '_')}, which is longer than MySQL's 32 characters; write a shorter user:`,
      );
    });
  });

  describe('point-in-time recovery', () => {
    it('is on from create, with no restart mark', () => {
      const step = created();

      expect(step.cloudSql?.pointInTimeRecovery).toBe(true);
      expect(step.cloudSql?.lines).toContain(
        'db-1 backups: 7 days, point-in-time recovery on',
      );
      expect(step.cloudSql?.lines.join('\n')).not.toContain('restarts');
    });

    it("turned on marks MySQL's one restart", () => {
      const step = planned(entry(), [onCloudSql(false)]).steps.find(
        (one) => one.action === 'change',
      );

      expect(step?.action === 'change' && step.cloudSql).toEqual({
        tier: null,
        version: null,
        pointInTimeRecovery: { from: false, to: true },
        lines: [
          'db-1 point-in-time recovery: off → on',
          'restarts db-1 once: about 20 s offline',
        ],
      });
    });

    it("turned off by native.gcp's binary_log_enabled, MySQL's switch for it, marks the same restart", () => {
      const off = entry(
        [
          '    native:',
          '      gcp:',
          '        google_sql_database_instance.database:',
          '          settings:',
          '            backup_configuration:',
          '              binary_log_enabled: false',
          '',
        ].join('\n'),
      );
      const step = planned(off, [onCloudSql(true)]).steps.find(
        (one) => one.action === 'change',
      );

      expect(step?.action === 'change' && step.cloudSql?.lines).toEqual(
        expect.arrayContaining([
          'db-1 point-in-time recovery: on → off',
          'restarts db-1 once: about 20 s offline',
        ]),
      );
    });

    it("refuses PostgreSQL's point_in_time_recovery_enabled by name, pointing at binary_log_enabled, where the plan kept it on and the provider refused it", () => {
      const at =
        'db-1.native.gcp."google_sql_database_instance.database".settings.backup_configuration.point_in_time_recovery_enabled';
      const off = entry(
        [
          '    native:',
          '      gcp:',
          '        google_sql_database_instance.database:',
          '          settings:',
          '            backup_configuration:',
          '              point_in_time_recovery_enabled: false',
          '',
        ].join('\n'),
      );

      expect(refusals(off, [onCloudSql(true)])).toEqual([
        {
          at,
          message: `${at}: refused - PostgreSQL's switch for point-in-time recovery, which a MySQL instance does not take; write settings.backup_configuration.binary_log_enabled`,
        },
      ]);
    });

    it('plans nothing for one made with it on', () => {
      expect(planned(entry(), [onCloudSql(true)]).steps).toEqual([]);
    });
  });

  it("lets a web in the Environment link an Existing database's url and ca, which is reached in its Cloud account as a postgres's is", () => {
    const existing: Extract<SavedService, { serviceType: 'mysql' }> = {
      ...onCloudSql(true),
      cloud: undefined,
      cloudSql: undefined,
      existing: {
        cloudAccountId: 'gca-1',
        region: 'europe-west1',
        identifier: 'shop-prod:europe-west1:acme',
        madeReachable: false,
      },
    };
    const text = `${entry()}  web:
    kind: web
    source: { image: nginx }
    env: [{ DATABASE_URL: db-1.url }, { MYSQL_CA: db-1.ca }]
`;

    expect(plan(text, [existing]).ok).toBe(true);
  });
});
