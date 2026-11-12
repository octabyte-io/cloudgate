import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanOutcome,
  SavedService,
} from '../../src/project-config';
import type { PostgresEntry } from '../../src/project-config/project-config.types';
import {
  cloudSqlChange,
  cloudSqlCreate,
} from '../../src/project-config/planner/cloud-sql';

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

const entry = (lines: string) =>
  `version: 1\nservices:\n  pg-1:\n    kind: postgres\n${lines}`;

/** The one create step a plan of `entry(lines)` makes. */
function created(lines: string) {
  const [step] = planned(entry(lines)).steps;
  if (step.action !== 'create') throw new Error(`a ${step.action}`);
  return step;
}

/** A postgres already made on Cloud SQL in this Environment. */
function onCloudSql(
  size: { cpu: number; memoryMb: number } | null,
  version = '16',
): Extract<SavedService, { serviceType: 'postgres' }> {
  return {
    serviceType: 'postgres',
    serviceId: 'pg-id',
    name: 'pg-1',
    configName: 'pg-1',
    cloud: {
      cloudAccountId: 'gca-1',
      region: 'europe-west1',
      cloud: 'gcp',
      linkedRegistries: [],
    },
    settings: {
      description: null,
      cpuLimit: size ? String(size.cpu * 1e9) : null,
      memoryLimit: size ? String(size.memoryMb * 1024 * 1024) : null,
      dockerImage: `postgres:${version}`,
      databaseName: 'pg_1',
      databaseUser: 'pg_1',
    },
    variables: { env: [] },
  };
}

/** What a new postgres on Cloud SQL's plan says of its backups. */
const BACKUPS_LINE = 'pg-1 backups: 7 days, point-in-time recovery on';

/**
 * `saved` with its Backups tab's retention, and the one its last Apply
 * wrote (`null`: made before backups).
 */
function backedUp(
  saved: Extract<SavedService, { serviceType: 'postgres' }>,
  backupRetentionDays: number,
  applied: number | null,
): Extract<SavedService, { serviceType: 'postgres' }> {
  return {
    ...saved,
    cloudSql: {
      backupRetentionDays,
      applied: applied === null ? null : { backupRetentionDays: applied },
    },
  };
}

/** The one change step a plan of `entry(lines)` over `saved` makes. */
function changed(lines: string, saved: SavedService) {
  const outcome = planned(entry(lines), [saved]);
  const step = outcome.steps.find((one) => one.action === 'change');
  if (!step || step.action !== 'change') throw new Error('no change');
  return { step, notes: outcome.notes };
}

describe('planEnvironment, a postgres on a Google Cloud Deploy target', () => {
  describe('size → Cloud SQL machine', () => {
    it.each([
      ['xsmall', 'db-g1-small'],
      ['small', 'db-g1-small'],
      ['medium', 'db-custom-1-3840'],
      ['large', 'db-custom-2-4096'],
      ['xlarge', 'db-custom-4-8192'],
      ['2xlarge', 'db-custom-8-16384'],
    ])('puts %s on %s', (size, tier) => {
      expect(created(`    size: ${size}\n`).cloudSql?.size).toMatchObject({
        name: size,
        tier,
        smallest: false,
      });
    });

    it.each([
      ['{ cpu: 1, memory: 8 GB }', 'db-custom-2-8192'],
      ['{ cpu: 3, memory: 5 GB }', 'db-custom-4-5120'],
      ['{ cpu: 0.1, memory: 256 MB }', 'db-f1-micro'],
      ['{ cpu: 2, memory: 1 GB }', 'db-custom-2-3840'],
      ['{ cpu: 1, memory: 4000 MB }', 'db-custom-1-4096'],
      ['{ cpu: 96, memory: 624 GB }', 'db-custom-96-638976'],
    ])('rounds the custom size %s up to %s', (size, tier) => {
      expect(created(`    size: ${size}\n`).cloudSql?.size).toMatchObject({
        name: null,
        tier,
      });
    });

    it('creates one with no size on db-f1-micro, the smallest', () => {
      expect(created('').cloudSql?.size).toEqual({
        name: null,
        tier: 'db-f1-micro',
        machine: 'shared CPU, 0.6 GB, no SLA',
        smallest: true,
      });
    });

    it.each([
      ['{ cpu: 97, memory: 624 GB }'],
      ['{ cpu: 96, memory: 625 GB }'],
      ['{ cpu: 1, memory: 700 GB }'],
    ])('refuses %s, above Cloud SQL’s largest shape, naming it', (size) => {
      expect(refusals(entry(`    size: ${size}\n`))).toEqual([
        {
          at: 'pg-1.size',
          message: expect.stringContaining(
            'above the largest Cloud SQL machine Cloudgate chooses, db-custom-96-638976 (96 vCPU, 624 GB)',
          ) as string,
        },
      ]);
    });
  });

  describe('plan lines', () => {
    it('names a shared-core machine with its memory and no SLA', () => {
      expect(created('    size: small\n').cloudSql?.lines).toEqual([
        'pg-1 small → db-g1-small (shared CPU, 1.7 GB, no SLA: for testing)',
        BACKUPS_LINE,
      ]);
    });

    it('names a custom machine with its vCPU and memory', () => {
      expect(created('    size: medium\n').cloudSql?.lines).toEqual([
        'pg-1 medium → db-custom-1-3840 (1 vCPU, 3.75 GB)',
        BACKUPS_LINE,
      ]);
    });

    it('names the smallest machine an entry with no size gets', () => {
      expect(created('').cloudSql?.lines).toEqual([
        'pg-1 no size → db-f1-micro (smallest: shared CPU, 0.6 GB, no SLA)',
        BACKUPS_LINE,
      ]);
    });
  });

  describe('backups', () => {
    it('makes a new one with 7 days of backups and point-in-time recovery, with no restart mark', () => {
      const step = created('    size: small\n');

      expect(step.cloudSql?.backupRetentionDays).toBe(7);
      expect(step.cloudSql?.pointInTimeRecovery).toBe(true);
      expect(step.cloudSql?.lines).toContain(BACKUPS_LINE);
      expect(step.cloudSql?.lines.join('\n')).not.toContain('restarts');
    });

    it('plans a retention edited on its Backups tab as a change, with no restart mark', () => {
      const { step } = changed(
        '    version: "16"\n',
        backedUp(onCloudSql(null), 14, 7),
      );

      expect(step.fields).toEqual([]);
      expect(step.cloudSql).toEqual({
        tier: null,
        version: null,
        backupRetentionDays: { from: 7, to: 14 },
        lines: ['pg-1 backups: 7 days → 14 days'],
      });
      expect(step.cloudRead).toEqual({ status: 'reading' });
    });

    it('plans nothing when its Backups tab holds what the last Apply wrote', () => {
      const outcome = planned(entry('    version: "16"\n'), [
        backedUp(onCloudSql(null), 30, 30),
      ]);

      expect(outcome.steps).toEqual([]);
    });

    it('catches one made before backups up: backups and deletion protection with no mark, point-in-time recovery marked as two restarts', () => {
      const { step } = changed(
        '    version: "16"\n',
        backedUp(onCloudSql(null), 7, null),
      );

      expect(step.fields).toEqual([]);
      expect(step.majorUpgrade).toBeUndefined();
      expect(step.cloudSql).toEqual({
        tier: null,
        version: null,
        catchUp: { backupRetentionDays: 7 },
        pointInTimeRecovery: { from: false, to: true },
        lines: [
          'pg-1 backups: off → 7 days, deletion protection: off → on',
          'pg-1 point-in-time recovery: off → on',
          'restarts pg-1 twice: about 15 s offline',
        ],
      });
      expect(step.cloudRead).toEqual({ status: 'reading' });
    });

    it('catches one made before backups up to the retention set on its Backups tab', () => {
      const { step } = changed(
        '    version: "16"\n',
        backedUp(onCloudSql(null), 30, null),
      );

      expect(step.cloudSql?.catchUp).toEqual({ backupRetentionDays: 30 });
      expect(step.cloudSql?.lines[0]).toBe(
        'pg-1 backups: off → 30 days, deletion protection: off → on',
      );
    });

    it('refuses to catch one up to a retention outside Cloud SQL’s 1 to 365', () => {
      expect(
        refusals(entry('    version: "16"\n'), [
          backedUp(onCloudSql(null), 0, null),
        ]),
      ).toEqual([
        {
          at: 'pg-1',
          message:
            "pg-1: a backup retention of 0 days is outside Cloud SQL's 1 to 365 days; set one on pg-1's Backups tab",
        },
      ]);
    });

    it('marks turning point-in-time recovery on for one whose last Apply wrote it off', () => {
      const { step } = changed('    version: "16"\n', {
        ...onCloudSql(null),
        cloudSql: {
          backupRetentionDays: 7,
          applied: { backupRetentionDays: 7, pointInTimeRecovery: false },
        },
      });

      expect(step.cloudSql).toEqual({
        tier: null,
        version: null,
        pointInTimeRecovery: { from: false, to: true },
        lines: [
          'pg-1 point-in-time recovery: off → on',
          'restarts pg-1 twice: about 15 s offline',
        ],
      });
      // The mark is a plan line, never a typed confirmation.
      expect(step.majorUpgrade).toBeUndefined();
    });

    it('plans nothing for one its last Apply wrote with point-in-time recovery on', () => {
      const outcome = planned(entry('    version: "16"\n'), [
        {
          ...onCloudSql(null),
          cloudSql: {
            backupRetentionDays: 7,
            applied: { backupRetentionDays: 7, pointInTimeRecovery: true },
          },
        },
      ]);

      expect(outcome.steps).toEqual([]);
    });

    it.each([1, 365])('takes a retention of %i days', (days) => {
      const { step } = changed(
        '    version: "16"\n',
        backedUp(onCloudSql(null), days, 7),
      );

      expect(step.cloudSql?.backupRetentionDays).toEqual({ from: 7, to: days });
    });

    it.each([0, 366])(
      'refuses a retention of %i days, outside Cloud SQL’s 1 to 365',
      (days) => {
        expect(
          refusals(entry('    version: "16"\n'), [
            backedUp(onCloudSql(null), days, 7),
          ]),
        ).toEqual([
          {
            at: 'pg-1',
            message: `pg-1: a backup retention of ${days} days is outside Cloud SQL's 1 to 365 days; set one on pg-1's Backups tab`,
          },
        ]);
      },
    );
  });

  describe('login', () => {
    it('makes pg-1 with no user: as user app_pg_1 on database pg_1, since PostgreSQL reserves pg_1 as a role', () => {
      expect(created('').cloudSql?.login).toEqual({
        user: 'app_pg_1',
        database: 'pg_1',
      });
    });

    it('makes the user and database written', () => {
      expect(
        created('    user: shop\n    database: orders\n').cloudSql?.login,
      ).toEqual({ user: 'shop', database: 'orders' });
    });
  });

  it('is read from Google Cloud as a Cloud SQL instance, never through an RDS definition', () => {
    const step = created('    size: small\n');

    expect(step.database).toBeUndefined();
    expect(step.cloudRead).toEqual({ status: 'reading' });
  });

  describe("the Environment network's private link", () => {
    function steps(
      text: string,
      networks: Parameters<typeof planEnvironment>[0]['networks'],
      saved: SavedService[] = [],
    ) {
      const parsed = parseProjectConfig(text);
      if (!parsed.ok) throw new Error('refused');
      const outcome = planEnvironment({
        config: parsed.config,
        saved,
        deployTarget: GOOGLE,
        cloud: 'gcp',
        context: { previous: null },
        networks,
      });
      if (!outcome.ok) throw new Error('refused');
      return outcome.steps;
    }
    const WEB_AND_PG = `version: 1\nservices:\n  web:\n    kind: web\n    source: { image: nginx }\n  pg-1:\n    kind: postgres\n`;
    const MADE = {
      cloudAccountId: 'gca-1',
      region: 'europe-west1',
      environmentNetworkId: 'net-1',
    };

    it('makes the Environment network first where there is none, with Cloud SQL’s private link', () => {
      const [network, ...rest] = steps(WEB_AND_PG, []);

      expect(network).toEqual({
        action: 'network-create',
        cloudAccountId: 'gca-1',
        region: 'europe-west1',
        privateLinks: ['cloud-sql'],
        cloudRead: { status: 'reading' },
      });
      expect(rest.map((step) => step.action)).toEqual(['create', 'create']);
    });

    it('adds the link to a made network that has none, as a network change of its own, first', () => {
      const [network, create] = steps(entry(''), [MADE]);

      expect(network).toEqual({
        action: 'network-change',
        environmentNetworkId: 'net-1',
        cloudAccountId: 'gca-1',
        region: 'europe-west1',
        privateLinks: ['cloud-sql'],
        cloudRead: { status: 'reading' },
      });
      expect(create).toMatchObject({ action: 'create', configName: 'pg-1' });
    });

    it('adds no second link when the network has it already', () => {
      expect(
        steps(entry(''), [{ ...MADE, privateLinks: ['cloud-sql'] }]).map(
          (step) => step.action,
        ),
      ).toEqual(['create']);
    });

    it('is not made for a web-only Environment', () => {
      const web = `version: 1\nservices:\n  web:\n    kind: web\n    source: { image: nginx }\n`;

      expect(steps(web, [])).toEqual([
        expect.not.objectContaining({
          privateLinks: expect.anything() as unknown,
        }) as object,
        expect.objectContaining({ action: 'create' }),
      ]);
      expect(steps(web, [MADE]).map((step) => step.action)).toEqual(['create']);
    });

    it('is left as it is by a plan whose config no longer has a postgres', () => {
      const web = `version: 1\nservices:\n  web:\n    kind: web\n    source: { image: nginx }\n`;
      const planned = steps(
        web,
        [{ ...MADE, privateLinks: ['cloud-sql'] }],
        [onCloudSql({ cpu: 0.5, memoryMb: 1024 }, '18')],
      );

      expect(
        planned.filter((step) => step.action.startsWith('network')),
      ).toEqual([]);
    });
  });

  describe('version', () => {
    it('reads the version by the shared rule, as Cloud SQL’s database version', () => {
      expect(created('    version: "17"\n').cloudSql?.version).toEqual({
        written: '17',
        major: 17,
        databaseVersion: 'POSTGRES_17',
      });
    });

    it('drops an image suffix, with a note', () => {
      const { steps, notes } = planned(entry('    version: 17-alpine\n'));

      expect(steps[0]).toMatchObject({
        cloudSql: { version: { databaseVersion: 'POSTGRES_17' } },
      });
      expect(notes).toContainEqual({
        kind: 'cloud-version-suffix',
        configName: 'pg-1',
        message:
          'pg-1.version: 17-alpine runs as PostgreSQL 17 on Cloud SQL; the image suffix -alpine is dropped',
      });
    });

    it('refuses a major Cloud SQL does not offer, naming Cloud SQL', () => {
      expect(refusals(entry('    version: "9"\n'))).toEqual([
        {
          at: 'pg-1.version',
          message: expect.stringContaining(
            'is not offered by Cloud SQL',
          ) as string,
        },
      ]);
    });
  });

  describe('a change to one on Cloud SQL', () => {
    it('shows xsmall → small as no change on GCP', () => {
      const { step, notes } = changed(
        '    version: "16"\n    size: small\n',
        onCloudSql({ cpu: 0.25, memoryMb: 512 }),
      );

      expect(step.cloudSql).toBeUndefined();
      expect(notes).toContainEqual({
        kind: 'cloud-same-class',
        configName: 'pg-1',
        message:
          'pg-1.size: xsmall → small runs on db-g1-small either way: no change on GCP',
      });
    });

    it('marks a machine change as a restart', () => {
      const { step } = changed(
        '    version: "16"\n    size: medium\n',
        onCloudSql({ cpu: 0.5, memoryMb: 1024 }),
      );

      expect(step.cloudSql).toEqual({
        tier: {
          from: 'db-g1-small',
          to: 'db-custom-1-3840',
          machine: '1 vCPU, 3.75 GB',
          sizeName: 'medium',
        },
        version: null,
        lines: [
          'pg-1 medium → db-custom-1-3840 (1 vCPU, 3.75 GB), from db-g1-small',
          'restarts pg-1: under a minute offline',
        ],
      });
      // Read from its own state.
      expect(step.cloudRead).toEqual({ status: 'reading' });
    });

    it('marks a major upgrade for Apply’s confirmation', () => {
      const { step } = changed('    version: "17"\n', onCloudSql(null, '16'));

      expect(step.majorUpgrade).toEqual({ from: '16', to: '17' });
      expect(step.cloudSql?.version).toEqual({
        from: '16',
        to: '17',
        databaseVersion: 'POSTGRES_17',
      });
    });

    it('refuses a downgrade, naming the version it runs', () => {
      expect(
        refusals(entry('    version: "15"\n'), [onCloudSql(null, '16')]),
      ).toEqual([
        {
          at: 'pg-1.version',
          message: expect.stringContaining(
            'is older than PostgreSQL 16, which pg-1 runs on Cloud SQL',
          ) as string,
        },
      ]);
    });

    it('refuses changing the user or the database, each fixed when it is made', () => {
      expect(
        refusals(
          entry('    version: "16"\n    user: other\n    database: other\n'),
          [onCloudSql(null)],
        ),
      ).toEqual([
        {
          at: 'pg-1.database',
          message:
            "pg-1.database: a Cloud SQL instance's database is fixed when it is made; keep database: pg_1",
        },
        {
          at: 'pg-1.user',
          message:
            "pg-1.user: a Cloud SQL instance's user is fixed when it is made; keep user: pg_1",
        },
      ]);
    });

    it('refuses a mysql’s user moved to root the same way, and stores no plan', () => {
      const mysql: SavedService = {
        ...onCloudSql(null),
        serviceType: 'mysql',
        settings: {
          ...onCloudSql(null).settings,
          dockerImage: 'mysql:8.4',
        },
      };

      expect(
        refusals(
          'version: 1\nservices:\n  pg-1:\n    kind: mysql\n    user: root\n',
          [mysql],
        ),
      ).toEqual([
        {
          at: 'pg-1.user',
          message:
            "pg-1.user: a Cloud SQL instance's user is fixed when it is made; keep user: pg_1",
        },
      ]);
    });

    it('lets a user or database change through on one whose Cloud run never made it, which the plan runs again with them', () => {
      const unmade: SavedService = {
        ...backedUp(onCloudSql(null), 7, 7),
        cloudSql: {
          backupRetentionDays: 7,
          applied: { backupRetentionDays: 7 },
          unmade: true,
        },
      };

      const outcome = planned(
        entry('    version: "16"\n    user: other\n    database: other\n'),
        [unmade],
      );

      expect(outcome.steps).toEqual([
        expect.objectContaining({
          action: 'change',
          configName: 'pg-1',
          cloudSql: { tier: null, version: null, lines: [] },
        }),
      ]);
    });

    it('only notes a user change on an Existing database, which Cloudgate does not make', () => {
      const existing: SavedService = {
        ...onCloudSql(null),
        cloud: undefined,
        existing: {
          cloudAccountId: 'gca-1',
          region: 'europe-west1',
          identifier: 'shop-prod:europe-west1:acme',
          madeReachable: false,
        },
      };

      const outcome = planned(entry('    version: "16"\n    user: other\n'), [
        existing,
      ]);

      expect(outcome.steps).toEqual([
        expect.objectContaining({
          action: 'change',
          configName: 'pg-1',
          existing: expect.objectContaining({
            identifier: 'shop-prod:europe-west1:acme',
          }) as unknown,
        }),
      ]);
    });
  });
});

/** pg-1's entry as `version: "16"` reads. */
function pgEntry(): PostgresEntry {
  const parsed = parseProjectConfig(entry('    version: "16"\n'));
  if (!parsed.ok) throw new Error(parsed.refusal.message);
  const found = parsed.config.services['pg-1'];
  if (found.kind !== 'postgres' || found.managed === 'console') {
    throw new Error('not a postgres the config describes');
  }
  return found;
}

/**
 * Point-in-time recovery's wanted value has one input in the planner
 * `native.gcp`'s open setting `point_in_time_recovery_enabled`
 * on when it says nothing. Here it is driven directly; the plan
 * of a config that turns it off is below.
 */
describe('cloudSqlChange', () => {
  const OFF = { pointInTimeRecovery: false };

  it('catches one made before backups up with point-in-time recovery left off: no flip and no mark', () => {
    const changed = cloudSqlChange(
      'pg-1',
      pgEntry(),
      backedUp(onCloudSql(null), 7, null),
      [],
      OFF,
    );

    expect(changed.refusals).toEqual([]);
    expect(changed.cloudSql).toEqual({
      tier: null,
      version: null,
      catchUp: { backupRetentionDays: 7 },
      lines: ['pg-1 backups: off → 7 days, deletion protection: off → on'],
    });
  });

  it('marks turning point-in-time recovery off as two restarts', () => {
    const changed = cloudSqlChange(
      'pg-1',
      pgEntry(),
      backedUp(onCloudSql(null), 7, 7),
      [],
      OFF,
    );

    expect(changed.cloudSql).toEqual({
      tier: null,
      version: null,
      pointInTimeRecovery: { from: true, to: false },
      lines: [
        'pg-1 point-in-time recovery: on → off',
        'restarts pg-1 twice: about 15 s offline',
      ],
    });
    expect(changed.majorUpgrade).toBeNull();
  });

  it('plans nothing for one its last Apply wrote with it off', () => {
    const changed = cloudSqlChange(
      'pg-1',
      pgEntry(),
      {
        ...onCloudSql(null),
        cloudSql: {
          backupRetentionDays: 7,
          applied: { backupRetentionDays: 7, pointInTimeRecovery: false },
        },
      },
      [],
      OFF,
    );

    expect(changed.cloudSql).toBeNull();
  });
});

describe('cloudSqlCreate', () => {
  it('makes one with point-in-time recovery off when it is wanted off, with no mark', () => {
    const made = cloudSqlCreate('pg-1', pgEntry(), {
      pointInTimeRecovery: false,
    });
    if (!made.ok) throw new Error('refused');

    expect(made.cloudSql.pointInTimeRecovery).toBe(false);
    expect(made.cloudSql.lines).toContain(
      'pg-1 backups: 7 days, point-in-time recovery off',
    );
    expect(made.cloudSql.lines.join('\n')).not.toContain('restarts');
  });
});

/**
 * ADR-0044 rules 3, 6 and 10: a postgres on Cloud SQL plans its
 * `native.gcp` as lines against the block its last Apply laid; a native
 * line moves the instance, read from Google Cloud with the block; its
 * backup count is the console's, handed back when taken out; and its
 * point-in-time recovery is the config's.
 */
describe('planEnvironment, a postgres on Cloud SQL with native.gcp', () => {
  const INSTANCE = '"google_sql_database_instance.database"';
  const native = (lines: string) =>
    `    version: "16"\n    native:\n      gcp:\n        ${INSTANCE}:\n${lines}`;
  const FLAGS =
    '          settings:\n            database_flags:\n              - name: log_min_duration_statement\n                value: "250"\n';
  const FLAG_LIST = [{ name: 'log_min_duration_statement', value: '250' }];
  const FLAGGED = {
    'google_sql_database_instance.database': {
      settings: { database_flags: FLAG_LIST },
    },
  };
  const made = () => backedUp(onCloudSql(null), 7, 7);

  it('creates it with its database_flags, as a native line its read lays', () => {
    const step = created(native(FLAGS));

    expect(step.cloudSql?.native).toEqual(FLAGGED);
    expect(step.fields).toContainEqual(
      expect.objectContaining({
        field: `native.gcp.${INSTANCE}.settings.database_flags`,
        from: null,
        to: FLAG_LIST,
        native: true,
      }),
    );
  });

  it('moves a made instance by a native line alone, its change carrying the block it lays', () => {
    const { step } = changed(native(FLAGS), made());

    expect(step.fields).toEqual([
      {
        field: `native.gcp.${INSTANCE}.settings.database_flags`,
        from: null,
        to: FLAG_LIST,
        native: true,
        fromDefault: true,
      },
    ]);
    expect(step.cloudSql).toEqual({
      tier: null,
      version: null,
      lines: [],
      native: FLAGGED,
    });
    expect(step.cloudRead).toEqual({ status: 'reading' });
  });

  it('plans nothing once its last Apply laid the same block', () => {
    const outcome = planned(entry(native(FLAGS)), [
      { ...made(), nativeGcp: FLAGGED },
    ]);

    expect(outcome.steps.filter((one) => one.action === 'change')).toEqual([]);
  });

  it("takes the last block out as a move with none, back to Cloudgate's flags", () => {
    const { step } = changed('    version: "16"\n', {
      ...made(),
      nativeGcp: FLAGGED,
    });

    expect(step.fields).toEqual([
      expect.objectContaining({
        field: `native.gcp.${INSTANCE}.settings.database_flags`,
        from: FLAG_LIST,
        to: null,
        toDefault: true,
      }),
    ]);
    expect(step.cloudSql?.native).toBeNull();
  });

  it('turns point-in-time recovery off natively, with its two restarts marked', () => {
    const { step } = changed(
      native(
        '          settings:\n            backup_configuration:\n              point_in_time_recovery_enabled: false\n',
      ),
      made(),
    );

    expect(step.fields).toEqual([
      expect.objectContaining({
        field: `native.gcp.${INSTANCE}.settings.backup_configuration.point_in_time_recovery_enabled`,
        from: true,
        to: false,
        fromDefault: true,
      }),
    ]);
    expect(step.cloudSql).toMatchObject({
      pointInTimeRecovery: { from: true, to: false },
      lines: [
        'pg-1 point-in-time recovery: on → off',
        'restarts pg-1 twice: about 15 s offline',
      ],
    });
  });

  const RETAINED = `native.gcp.${INSTANCE}.settings.backup_configuration.backup_retention_settings.retained_backups`;
  const KEEP_14 =
    '          settings:\n            backup_configuration:\n              backup_retention_settings:\n                retained_backups: 14\n';

  it("sets the backups the Backups tab owned, over the console's value", () => {
    const { step } = changed(native(KEEP_14), made());

    expect(step.fields).toEqual([
      { field: RETAINED, from: 7, to: 14, native: true, fromConsole: true },
    ]);
  });

  it('makes a new one keeping the backups native sets', () => {
    const step = created(native(KEEP_14));

    expect(step.cloudSql?.backupRetentionDays).toBe(14);
    expect(step.cloudSql?.lines).toContain(
      'pg-1 backups: 14 days, point-in-time recovery on',
    );
  });

  it('hands a backup count taken out back to the console where it is, never to the default', () => {
    // Its Apply wrote 14 to the Backups tab's column beside the block.
    const { step } = changed('    version: "16"\n', {
      ...backedUp(onCloudSql(null), 14, 14),
      nativeGcp: {
        'google_sql_database_instance.database': {
          settings: {
            backup_configuration: {
              backup_retention_settings: { retained_backups: 14 },
            },
          },
        },
      },
    });

    expect(step.fields).toEqual([
      { field: RETAINED, from: 14, to: 14, native: true, toConsole: true },
    ]);
    expect(step.cloudSql).toEqual({
      tier: null,
      version: null,
      lines: [],
      native: null,
    });
  });

  it('refuses a locked setting by its path, as on every target', () => {
    expect(
      refusals(
        entry(
          native(
            '          settings:\n            ip_configuration:\n              ipv4_enabled: true\n',
          ),
        ),
        [made()],
      ).map((one) => one.at),
    ).toContain(`pg-1.native.gcp.${INSTANCE}.settings.ip_configuration`);
  });

  it("refuses MySQL's binary_log_enabled by name, pointing at PostgreSQL's point_in_time_recovery_enabled", () => {
    const at = `pg-1.native.gcp.${INSTANCE}.settings.backup_configuration.binary_log_enabled`;

    expect(
      refusals(
        entry(
          native(
            '          settings:\n            backup_configuration:\n              binary_log_enabled: false\n',
          ),
        ),
        [made()],
      ),
    ).toEqual([
      {
        at,
        message: `${at}: refused - MySQL's switch for point-in-time recovery, which a PostgreSQL instance does not take; write settings.backup_configuration.point_in_time_recovery_enabled`,
      },
    ]);
  });
});

describe('planEnvironment, an exact tier on Cloud SQL: native.gcp settings.tier wins over size', () => {
  const INSTANCE = '"google_sql_database_instance.database"';
  const TIER = `native.gcp.${INSTANCE}.settings.tier`;
  const withTier = (size: string, tier = 'db-perf-optimized-N-4') =>
    `    version: "16"\n${size}    native:\n      gcp:\n        ${INSTANCE}:\n          settings:\n            tier: ${tier}\n`;
  const BLOCK = {
    'google_sql_database_instance.database': {
      settings: { tier: 'db-perf-optimized-N-4' },
    },
  };
  /** Made at `medium` (db-custom-1-3840), with backups. */
  const madeMedium = () =>
    backedUp(onCloudSql({ cpu: 1, memoryMb: 2048 }), 7, 7);
  /** `saved` applied with the native tier, which it runs on since. */
  const onNative = (
    saved: Extract<SavedService, { serviceType: 'postgres' }>,
  ): SavedService => ({
    ...saved,
    cloudSql: {
      backupRetentionDays: 7,
      applied: { backupRetentionDays: 7 },
      tier: 'db-perf-optimized-N-4',
    },
    nativeGcp: BLOCK,
  });
  const nativeLines = (step: { fields: readonly unknown[] }) =>
    step.fields.filter((field) => (field as { native?: true }).native);

  it('creates it on the native tier, its size line naming the size it gives way to', () => {
    const step = created(withTier('    size: medium\n'));

    expect(step.cloudSql?.size).toEqual({
      name: 'medium',
      tier: 'db-perf-optimized-N-4',
      machine: '4 vCPU, 32 GB',
      smallest: false,
      native: true,
    });
    expect(step.cloudSql?.lines[0]).toBe(
      'pg-1 medium → db-perf-optimized-N-4 (4 vCPU, 32 GB), set by native',
    );
    expect(nativeLines(step)).toEqual([
      {
        field: TIER,
        from: null,
        to: 'db-perf-optimized-N-4',
        native: true,
        fromSize: true,
      },
    ]);
  });

  it('names a tier the committed table does not know alone, and a custom shape by its name', () => {
    expect(
      created(withTier('    size: medium\n', 'db-memory-optimized-N-4'))
        .cloudSql?.lines[0],
    ).toBe('pg-1 medium → db-memory-optimized-N-4, set by native');
    expect(created(withTier('', 'db-custom-4-16384')).cloudSql?.lines[0]).toBe(
      'pg-1 → db-custom-4-16384 (4 vCPU, 16 GB), set by native',
    );
  });

  it('does not refuse a size no machine Cloudgate chooses holds, since the native tier is what runs', () => {
    expect(
      created(withTier('    size: { cpu: 128, memory: 1024 GB }\n')).cloudSql
        ?.size,
    ).toMatchObject({ tier: 'db-perf-optimized-N-4', native: true });
  });

  it('moves a made instance to the native tier, marked native, with the restart a machine move warns of', () => {
    const { step } = changed(withTier('    size: medium\n'), madeMedium());

    expect(nativeLines(step)).toEqual([
      {
        field: TIER,
        from: 'db-custom-1-3840',
        to: 'db-perf-optimized-N-4',
        native: true,
        fromSize: true,
      },
    ]);
    expect(step.cloudSql).toEqual({
      tier: {
        from: 'db-custom-1-3840',
        to: 'db-perf-optimized-N-4',
        machine: '4 vCPU, 32 GB',
        sizeName: 'medium',
        native: true,
      },
      version: null,
      lines: [
        'pg-1 medium → db-perf-optimized-N-4 (4 vCPU, 32 GB), set by native, from db-custom-1-3840',
        'restarts pg-1: under a minute offline',
      ],
      native: BLOCK,
    });
  });

  it('plans nothing once the native tier is applied, and a size change it wins over is only noted', () => {
    expect(
      planned(entry(withTier('    size: medium\n')), [onNative(madeMedium())])
        .steps,
    ).toEqual([]);

    const { step, notes } = changed(
      withTier('    size: large\n'),
      onNative(madeMedium()),
    );
    expect(step.fields).toEqual([
      { field: 'size', from: 'medium', to: 'large' },
    ]);
    expect(step.cloudSql).toBeUndefined();
    expect(notes).toContainEqual(
      expect.objectContaining({
        kind: 'cloud-same-class',
        message:
          'pg-1.size: medium → large runs on db-perf-optimized-N-4 either way: no change on GCP',
      }),
    );
  });

  it("taken out with a size, falls back to the size's tier, as the restart it is", () => {
    const { step } = changed(
      '    version: "16"\n    size: medium\n',
      onNative(madeMedium()),
    );

    expect(nativeLines(step)).toEqual([
      {
        field: TIER,
        from: 'db-perf-optimized-N-4',
        to: 'db-custom-1-3840',
        native: true,
        toSize: true,
      },
    ]);
    expect(step.cloudSql).toEqual({
      tier: {
        from: 'db-perf-optimized-N-4',
        to: 'db-custom-1-3840',
        machine: '1 vCPU, 3.75 GB',
        sizeName: 'medium',
      },
      version: null,
      lines: [
        'pg-1 medium → db-custom-1-3840 (1 vCPU, 3.75 GB), from db-perf-optimized-N-4',
        'restarts pg-1: under a minute offline',
      ],
      native: null,
    });
  });

  it('taken out with no size, stays where it is and is handed back to the console, never the smallest', () => {
    const { step } = changed('    version: "16"\n', onNative(onCloudSql(null)));

    expect(nativeLines(step)).toEqual([
      {
        field: TIER,
        from: 'db-perf-optimized-N-4',
        to: 'db-perf-optimized-N-4',
        native: true,
        toConsole: true,
      },
    ]);
    expect(step.cloudSql).toEqual({
      tier: null,
      version: null,
      lines: [],
      native: null,
    });
  });

  it("plans the same file's size caps on a Server, where native.gcp is checked only", () => {
    const parsed = parseProjectConfig(entry(withTier('    size: medium\n')));
    if (!parsed.ok) throw new Error('refused');
    const outcome = planEnvironment({
      config: parsed.config,
      saved: [],
      deployTarget: { kind: 'server', serverId: 'srv-1' },
      context: { previous: null },
    });

    if (!outcome.ok) throw new Error('refused');
    const [step] = outcome.steps;
    if (step.action !== 'create') throw new Error(step.action);
    expect(step).not.toHaveProperty('cloudSql');
    expect(step.fields).toContainEqual({
      field: 'size',
      from: null,
      to: 'medium',
    });
    expect(nativeLines(step)).toEqual([]);
  });
});
