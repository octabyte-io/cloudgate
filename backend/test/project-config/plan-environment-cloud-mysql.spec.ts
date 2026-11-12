import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanOutcome,
  ProjectConfig,
  SavedService,
} from '../../src/project-config';

/**
 * A `mysql` on an AWS Deploy target is an RDS for MySQL instance,
 * planned by `postgres` on RDS's rules with MySQL's parameters; on Google
 * Cloud it is a Cloud SQL one (`plan-environment-cloud-sql-mysql`).
 */

const AWS: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-1',
  region: 'eu-west-1',
};

function config(text: string): ProjectConfig {
  const result = parseProjectConfig(text);
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.config;
}

function plan(
  text: string,
  saved: SavedService[] = [],
  cloud: 'aws' | 'gcp' = 'aws',
): PlanOutcome {
  return planEnvironment({
    config: config(text),
    saved,
    deployTarget: AWS,
    cloud,
    context: { previous: null },
    networks: [{ cloudAccountId: 'ca-1', region: 'eu-west-1' }],
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

/** A mysql already made on RDS in this Environment. */
function onRds(
  dockerImage = 'mysql:8.4',
): Extract<SavedService, { serviceType: 'mysql' }> {
  return {
    serviceType: 'mysql',
    serviceId: 'my-id',
    name: 'db-1',
    configName: 'db-1',
    cloud: {
      cloudAccountId: 'ca-1',
      region: 'eu-west-1',
      linkedRegistries: [],
    },
    rds: {
      instanceClass: 'db.t4g.micro',
      storageGb: 20,
      maxStorageGb: 200,
      multiAz: false,
      backupRetentionDays: 7,
      applied: null,
    },
    settings: {
      description: null,
      cpuLimit: null,
      memoryLimit: null,
      dockerImage,
      databaseName: 'db_1',
      databaseUser: 'db_1',
    },
    variables: { env: [] },
  };
}

describe('planEnvironment, a mysql on an AWS Deploy target', () => {
  it('creates an RDS for MySQL instance: no version is 8.4, its database always set', () => {
    const { steps } = planned(entry('    size: small\n'));

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'create',
        configName: 'db-1',
        kind: 'mysql',
        database: {
          size: {
            name: 'small',
            instanceClass: 'db.t4g.micro',
            machine: '2 vCPU, 1 GB',
            smallest: false,
          },
          version: {
            written: '8.4',
            engineVersion: '8.4',
            autoMinorUpgrade: true,
          },
          login: { user: 'db_1', database: 'db_1' },
        },
        cloudRead: { status: 'reading' },
      }),
    ]);
  });

  it.each([
    ['    version: "8.0"\n', 'db-1.version', 'MySQL 8.0'],
    ['    version: "9.1"\n', 'db-1.version', 'MySQL 9.1'],
    ['    user: root\n', 'db-1.user', 'root'],
  ])('refuses %j by name', (lines, at, named) => {
    const [refusal] = refusals(entry(lines));

    expect(refusal.at).toBe(at);
    expect(refusal.message).toContain(named);
  });

  it('refuses a user over 32 characters', () => {
    const outcome = parseProjectConfig(entry(`    user: ${'a'.repeat(33)}\n`));

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.refusal.message).toContain('32');
  });

  it('refuses a user over 16 characters on RDS at plan, naming the limit', () => {
    const [refusal] = refusals(entry(`    user: ${'a'.repeat(17)}\n`));

    expect(refusal.at).toBe('db-1.user');
    expect(refusal.message).toContain('1 to 16');
  });

  it('refuses the default user of a name over 16 characters, naming the field', () => {
    const [refusal] = refusals(
      'version: 1\nservices:\n  orders-database-1:\n    kind: mysql\n',
    );

    expect(refusal.at).toBe('orders-database-1.user');
    expect(refusal.message).toContain('1 to 16');
  });

  it('plans a new 8.4 minor as a change of the instance', () => {
    const { steps } = planned(entry('    version: "8.4.6"\n'), [onRds()]);

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'change',
        kind: 'mysql',
        database: {
          instanceClass: null,
          version: {
            from: '8.4',
            to: '8.4.6',
            engineVersion: '8.4.6',
            autoMinorUpgrade: false,
          },
          settings: [],
        },
        cloudRead: { status: 'reading' },
      }),
    ]);
  });

  it('refuses moving one on RDS to 8.0, naming it', () => {
    const [refusal] = refusals(entry('    version: "8.0"\n'), [onRds()]);

    expect(refusal.message).toContain('MySQL 8.0');
  });

  it('refuses a new user on one already made, as for a postgres', () => {
    const [refusal] = refusals(entry('    user: shop\n'), [onRds()]);

    expect(refusal).toEqual({
      at: 'db-1.user',
      message:
        "db-1.user: an RDS instance's master user is fixed when it is made; keep user: db_1",
    });
  });

  it("lets a web link an Existing database's url and ca, reached in the Cloud account it is looked up in, as a postgres's is", () => {
    const existing: SavedService = {
      ...onRds(),
      cloud: undefined,
      rds: undefined,
      existing: {
        cloudAccountId: 'ca-1',
        region: 'eu-west-1',
        identifier: 'acme-prod',
        madeReachable: true,
      },
    };
    const text = `${entry()}  web:
    kind: web
    source: { image: nginx }
    env: [{ DATABASE_URL: db-1.url }, { MYSQL_CA: db-1.ca }]
`;

    expect(plan(text, [existing]).ok).toBe(true);
  });

  it('is made on Cloud SQL on Google Cloud, never through RDS', () => {
    const step = planned(entry(), [], 'gcp').steps.find(
      (one) => one.action === 'create',
    );

    expect(step).toHaveProperty('cloudSql');
    expect(step).not.toHaveProperty('database');
  });
});
