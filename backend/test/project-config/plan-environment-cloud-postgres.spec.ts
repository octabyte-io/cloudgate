import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanOutcome,
  ProjectConfig,
  SavedService,
} from '../../src/project-config';

const CLOUD: DeployTarget = {
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
  networks = [{ cloudAccountId: 'ca-1', region: 'eu-west-1' }],
): PlanOutcome {
  return planEnvironment({
    config: config(text),
    saved,
    deployTarget: CLOUD,
    context: { previous: null },
    networks,
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

/** A postgres already made on RDS in this Environment. */
function onRds(
  settings: Partial<{
    dockerImage: string;
    cpuLimit: string | null;
    memoryLimit: string | null;
  }> = {},
): SavedService {
  return {
    serviceType: 'postgres',
    serviceId: 'pg-id',
    name: 'pg-1',
    configName: 'pg-1',
    cloud: {
      cloudAccountId: 'ca-1',
      region: 'eu-west-1',
      linkedRegistries: [],
    },
    settings: {
      description: null,
      cpuLimit: String(0.5e9),
      memoryLimit: String(1024 * 1024 * 1024),
      dockerImage: 'postgres:17',
      databaseName: 'pg_1',
      databaseUser: 'pg_1',
      ...settings,
    },
    variables: { env: [] },
  };
}

describe('planEnvironment, a postgres on an AWS Deploy target', () => {
  it('creates it as an RDS instance reading AWS, with its class, version and login', () => {
    const { steps } = planned(entry('    version: "17"\n    size: small\n'));

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'create',
        configName: 'pg-1',
        kind: 'postgres',
        placement: CLOUD,
        database: {
          size: {
            name: 'small',
            instanceClass: 'db.t4g.micro',
            machine: '2 vCPU, 1 GB',
            smallest: false,
          },
          version: {
            written: '17',
            engineVersion: '17',
            autoMinorUpgrade: true,
          },
          // PostgreSQL reserves pg_1 as a role, so the default user is app_ it.
          login: { user: 'app_pg_1', database: 'pg_1' },
        },
        cloudRead: { status: 'reading' },
      }),
    ]);
  });

  it('makes the Environment network first where there is none', () => {
    const { steps } = planned(entry('    version: "17"\n'), [], []);

    expect(steps.map((step) => step.action)).toEqual([
      'network-create',
      'create',
    ]);
  });

  it('puts an entry with no size on the smallest class', () => {
    const { steps } = planned(entry(''));
    const step = steps[0];

    expect(step.action === 'create' && step.database?.size).toEqual({
      name: null,
      instanceClass: 'db.t4g.micro',
      machine: '2 vCPU, 1 GB',
      smallest: true,
    });
  });

  it('notes an image suffix the cloud drops', () => {
    const { notes } = planned(entry('    version: "17-alpine"\n'));

    expect(notes).toContainEqual({
      kind: 'cloud-version-suffix',
      configName: 'pg-1',
      message:
        'pg-1.version: 17-alpine runs as PostgreSQL 17 on RDS; the image suffix -alpine is dropped',
    });
  });

  it('refuses a user RDS refuses, naming the field', () => {
    expect(refusals(entry('    user: app-user\n'))).toEqual([
      expect.objectContaining({ at: 'pg-1.user' }),
    ]);
    expect(refusals(entry('    user: rdsadmin\n'))[0].message).toContain(
      'rdsadmin',
    );
  });

  it('refuses a version RDS does not offer, naming it', () => {
    const [refusal] = refusals(entry('    version: "12"\n'));

    expect(refusal.at).toBe('pg-1.version');
    expect(refusal.message).toContain('PostgreSQL 12 is not offered by RDS');
  });

  it('refuses a size above db.m7g.2xlarge, naming the class', () => {
    const [refusal] = refusals(entry('    size: { cpu: 16, memory: 64 GB }\n'));

    expect(refusal.at).toBe('pg-1.size');
    expect(refusal.message).toContain('db.m7g.2xlarge');
  });

  it('plans "no change on AWS" for two sizes that land on the same class', () => {
    const { steps, notes } = planned(
      entry('    version: "17"\n    size: xsmall\n'),
      [onRds()],
    );

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'pg-1',
        fields: [{ field: 'size', from: 'small', to: 'xsmall' }],
      }),
    ]);
    expect(notes).toContainEqual({
      kind: 'cloud-same-class',
      configName: 'pg-1',
      message:
        'pg-1.size: small → xsmall runs on db.t4g.micro either way: no change on AWS',
    });
  });

  it('plans a class change that reads AWS, from the class it runs on', () => {
    const { steps } = planned(entry('    version: "17"\n    size: large\n'), [
      onRds(),
    ]);

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'pg-1',
        fields: [{ field: 'size', from: 'small', to: 'large' }],
        database: {
          instanceClass: {
            from: 'db.t4g.micro',
            to: 'db.t4g.medium',
            machine: '2 vCPU, 4 GB',
            sizeName: 'large',
          },
          version: null,
          settings: [],
        },
        cloudRead: { status: 'reading' },
      }),
    ]);
    expect(steps[0]).not.toHaveProperty('majorUpgrade');
  });

  it('plans a newer major as a major upgrade for Apply to confirm', () => {
    const { steps } = planned(entry('    version: "18"\n    size: small\n'), [
      onRds(),
    ]);

    expect(steps[0]).toMatchObject({
      action: 'change',
      majorUpgrade: { from: '17', to: '18' },
      database: {
        instanceClass: null,
        version: {
          from: '17',
          to: '18',
          engineVersion: '18',
          autoMinorUpgrade: true,
        },
      },
      cloudRead: { status: 'reading' },
    });
  });

  it('refuses an older major, naming the version it runs', () => {
    const [refusal] = refusals(entry('    version: "17"\n    size: small\n'), [
      onRds({ dockerImage: 'postgres:18' }),
    ]);

    expect(refusal).toEqual({
      at: 'pg-1.version',
      message:
        'pg-1.version: "17" is older than PostgreSQL 18, which pg-1 runs on RDS, and RDS cannot move an instance back to an older major version; keep version: "18"',
    });
  });

  it("plans the console's settings that differ from what was applied, with no field", () => {
    const applied = {
      instanceClass: null,
      storageGb: 20,
      maxStorageGb: 200,
      multiAz: false,
      backupRetentionDays: 7,
    };
    const saved = {
      ...onRds(),
      rds: {
        ...applied,
        storageGb: 50,
        multiAz: true,
        backupRetentionDays: 14,
        applied,
      },
    };

    const { steps } = planned(entry('    version: "17"\n    size: small\n'), [
      saved,
    ]);

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'change',
        fields: [],
        database: {
          instanceClass: null,
          version: null,
          settings: [
            { setting: 'storageGb', from: 20, to: 50 },
            { setting: 'backupRetentionDays', from: 7, to: 14 },
            { setting: 'multiAz', from: false, to: true },
          ],
        },
        cloudRead: { status: 'reading' },
      }),
    ]);
  });

  it("plans the console's class for an entry with no size", () => {
    const applied = {
      instanceClass: 'db.t4g.micro',
      storageGb: 20,
      maxStorageGb: 200,
      multiAz: false,
      backupRetentionDays: 7,
    };
    const saved = {
      ...onRds({ cpuLimit: null, memoryLimit: null }),
      rds: { ...applied, instanceClass: 'db.t4g.small', applied },
    };

    const { steps } = planned(entry('    version: "17"\n'), [saved]);

    expect(steps[0]).toMatchObject({
      action: 'change',
      database: {
        instanceClass: {
          from: 'db.t4g.micro',
          to: 'db.t4g.small',
          machine: '2 vCPU, 2 GB',
          sizeName: null,
        },
      },
    });
  });

  it('plans nothing when nothing moved', () => {
    const { steps } = planned(entry('    version: "17"\n    size: small\n'), [
      onRds(),
    ]);

    expect(steps).toEqual([]);
  });

  it('refuses changing the user or the database of an RDS instance, naming each', () => {
    expect(
      refusals(
        entry(
          '    version: "17"\n    size: small\n    user: other\n    database: other\n',
        ),
        [onRds()],
      )
        .map((refusal) => refusal.at)
        .sort(),
    ).toEqual(['pg-1.database', 'pg-1.user']);
  });

  it('changes a postgres that runs on a Server as before, keeping its place', () => {
    const saved = { ...onRds(), cloud: undefined };

    const { steps } = planned(entry('    version: "17"\n    size: large\n'), [
      saved,
    ]);

    expect(steps).toEqual([
      expect.objectContaining({ action: 'change', configName: 'pg-1' }),
    ]);
  });

  it('makes a mysql there too, on RDS by the same rules', () => {
    const { steps } = planned(
      'version: 1\nservices:\n  db:\n    kind: mysql\n',
    );

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'create',
        kind: 'mysql',
        database: expect.objectContaining({
          login: { user: 'db', database: 'db' },
        }) as object,
      }),
    ]);
  });
});

describe('planEnvironment, native.aws on a postgres or a mysql on RDS', () => {
  const INSTANCE = 'native.aws."aws_db_instance.database"';
  const applied = {
    instanceClass: null,
    storageGb: 20,
    maxStorageGb: 200,
    multiAz: false,
    backupRetentionDays: 7,
  };
  const withNative = (lines: string) =>
    entry(
      `    version: "17"\n    size: small\n    native:\n      aws:\n        "aws_db_instance.database":\n${lines}`,
    );
  const nativeLines = (step: unknown) =>
    (step as { fields: { native?: true }[] }).fields.filter(
      (field) => field.native,
    );

  it('creates it with each native value as a native line, its read laying the block', () => {
    const { steps } = planned(withNative('          allocated_storage: 50\n'));

    expect(steps[0]).toMatchObject({
      action: 'create',
      database: {
        native: { 'aws_db_instance.database': { allocated_storage: 50 } },
      },
    });
    expect(nativeLines(steps[0])).toEqual([
      {
        field: `${INSTANCE}.allocated_storage`,
        from: null,
        to: 50,
        native: true,
        fromConsole: true,
      },
    ]);
  });

  it("plans a console-owned value over the console's, which moves the instance and reads AWS", () => {
    const saved = { ...onRds(), rds: { ...applied, applied } };

    const { steps } = planned(withNative('          allocated_storage: 50\n'), [
      saved,
    ]);

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'change',
        fields: [
          {
            field: `${INSTANCE}.allocated_storage`,
            from: 20,
            to: 50,
            native: true,
            fromConsole: true,
          },
        ],
        database: {
          instanceClass: null,
          version: null,
          settings: [],
          native: { 'aws_db_instance.database': { allocated_storage: 50 } },
        },
        cloudRead: { status: 'reading' },
      }),
    ]);
  });

  it('plans nothing when the block is the one its last Apply laid', () => {
    const saved = {
      ...onRds(),
      rds: {
        ...applied,
        storageGb: 50,
        applied: { ...applied, storageGb: 50 },
      },
      nativeAws: { 'aws_db_instance.database': { allocated_storage: 50 } },
    };

    const { steps } = planned(withNative('          allocated_storage: 50\n'), [
      saved,
    ]);

    expect(steps).toEqual([]);
  });

  it('hands a console-owned value taken out back to the console where it is, never to the default', () => {
    // Its Apply wrote the native 50 to the console's column too.
    const saved = {
      ...onRds(),
      rds: {
        ...applied,
        storageGb: 50,
        applied: { ...applied, storageGb: 50 },
      },
      nativeAws: { 'aws_db_instance.database': { allocated_storage: 50 } },
    };

    const { steps } = planned(entry('    version: "17"\n    size: small\n'), [
      saved,
    ]);

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'change',
        fields: [
          {
            field: `${INSTANCE}.allocated_storage`,
            from: 50,
            to: 50,
            native: true,
            toConsole: true,
          },
        ],
        database: expect.objectContaining({
          settings: [],
          native: null,
        }) as object,
      }),
    ]);
  });

  it("returns any other key taken out to Cloudgate's own, as on a web", () => {
    const saved = {
      ...onRds(),
      rds: { ...applied, applied },
      nativeAws: {
        'aws_db_instance.database': { performance_insights_enabled: true },
      },
    };

    const { steps } = planned(entry('    version: "17"\n    size: small\n'), [
      saved,
    ]);

    expect(nativeLines(steps[0])).toEqual([
      {
        field: `${INSTANCE}.performance_insights_enabled`,
        from: true,
        to: null,
        native: true,
        toDefault: true,
      },
    ]);
  });

  it('plans a mysql on RDS as a postgres', () => {
    const saved = {
      ...onRds({ dockerImage: 'mysql:8.4' }),
      serviceType: 'mysql',
      configName: 'db',
      rds: { ...applied, applied },
    } as SavedService;

    const { steps } = planned(
      'version: 1\nservices:\n  db:\n    kind: mysql\n    version: "8.4"\n    size: small\n    native:\n      aws:\n        "aws_db_instance.database":\n          multi_az: true\n',
      [saved],
    );

    expect(steps[0]).toMatchObject({
      action: 'change',
      kind: 'mysql',
      fields: [
        {
          field: `${INSTANCE}.multi_az`,
          from: false,
          to: true,
          native: true,
          fromConsole: true,
        },
      ],
      database: {
        native: { 'aws_db_instance.database': { multi_az: true } },
      },
    });
  });

  it('plans no native line on a Server, where the block is checked only', () => {
    const outcome = planEnvironment({
      config: config(withNative('          allocated_storage: 50\n')),
      saved: [],
      deployTarget: { kind: 'server', serverId: 'srv-1' },
      context: { previous: null },
    });

    expect(outcome.ok && nativeLines(outcome.steps[0])).toEqual([]);
  });
});

describe('planEnvironment, an exact class on RDS: native.aws instance_class wins over size', () => {
  const INSTANCE = 'native.aws."aws_db_instance.database"';
  const MEDIUM = {
    cpuLimit: String(1e9),
    memoryLimit: String(2 * 1024 * 1024 * 1024),
  };
  const console = {
    instanceClass: null,
    storageGb: 20,
    maxStorageGb: 200,
    multiAz: false,
    backupRetentionDays: 7,
  };
  const nativeClass = (size: string) =>
    entry(
      `    version: "17"\n${size}    native:\n      aws:\n        "aws_db_instance.database":\n          instance_class: db.r7g.xlarge\n`,
    );
  /** Made at `medium`, then applied with `instance_class: db.r7g.xlarge`. */
  const appliedNative = (): SavedService =>
    ({
      ...onRds(MEDIUM),
      rds: {
        ...console,
        instanceClass: 'db.r7g.xlarge',
        applied: { ...console, instanceClass: 'db.r7g.xlarge' },
      },
      nativeAws: {
        'aws_db_instance.database': { instance_class: 'db.r7g.xlarge' },
      },
    }) as SavedService;
  const nativeLines = (step: unknown) =>
    (step as { fields: { native?: true }[] }).fields.filter(
      (field) => field.native,
    );

  it('creates it on the native class, its size line naming the size it gives way to', () => {
    const { steps } = planned(nativeClass('    size: medium\n'));

    expect(steps[0]).toMatchObject({
      action: 'create',
      database: {
        size: {
          name: 'medium',
          instanceClass: 'db.r7g.xlarge',
          machine: '4 vCPU, 32 GB',
          smallest: false,
          native: true,
        },
        native: {
          'aws_db_instance.database': { instance_class: 'db.r7g.xlarge' },
        },
      },
    });
    expect(nativeLines(steps[0])).toEqual([
      {
        field: `${INSTANCE}.instance_class`,
        from: null,
        to: 'db.r7g.xlarge',
        native: true,
        fromSize: true,
      },
    ]);
  });

  it('does not refuse a size no class Cloudgate chooses holds, since the native class is what runs', () => {
    const { steps } = planned(
      nativeClass('    size:\n      cpu: 32\n      memory: 256 GB\n'),
    );

    expect(steps[0]).toMatchObject({
      database: { size: { instanceClass: 'db.r7g.xlarge', native: true } },
    });
  });

  it('moves a made instance to the native class, marked native, as a restart its read warns of', () => {
    const saved = { ...onRds(MEDIUM), rds: { ...console, applied: console } };

    const { steps } = planned(nativeClass('    size: medium\n'), [saved]);

    expect(steps[0]).toMatchObject({
      action: 'change',
      fields: [
        {
          field: `${INSTANCE}.instance_class`,
          from: 'db.t4g.small',
          to: 'db.r7g.xlarge',
          native: true,
          fromSize: true,
        },
      ],
      database: {
        instanceClass: {
          from: 'db.t4g.small',
          to: 'db.r7g.xlarge',
          machine: '4 vCPU, 32 GB',
          sizeName: 'medium',
          native: true,
        },
        native: {
          'aws_db_instance.database': { instance_class: 'db.r7g.xlarge' },
        },
      },
      cloudRead: { status: 'reading' },
    });
  });

  it('plans nothing once the native class is applied, and a size change it wins over is only noted', () => {
    expect(
      planned(nativeClass('    size: medium\n'), [appliedNative()]).steps,
    ).toEqual([]);

    const { steps, notes } = planned(nativeClass('    size: large\n'), [
      appliedNative(),
    ]);
    expect(steps[0]).toMatchObject({
      action: 'change',
      fields: [{ field: 'size', from: 'medium', to: 'large' }],
    });
    expect(steps[0]).not.toHaveProperty('database');
    expect(notes).toContainEqual(
      expect.objectContaining({
        kind: 'cloud-same-class',
        message:
          'pg-1.size: medium → large runs on db.r7g.xlarge either way: no change on AWS',
      }),
    );
  });

  it("taken out with a size, falls back to the size's class", () => {
    const { steps } = planned(entry('    version: "17"\n    size: medium\n'), [
      appliedNative(),
    ]);

    expect(steps[0]).toMatchObject({
      action: 'change',
      fields: [
        {
          field: `${INSTANCE}.instance_class`,
          from: 'db.r7g.xlarge',
          to: 'db.t4g.small',
          native: true,
          toSize: true,
        },
      ],
      database: {
        instanceClass: {
          from: 'db.r7g.xlarge',
          to: 'db.t4g.small',
          sizeName: 'medium',
        },
        native: null,
      },
    });
  });

  it('taken out with no size, stays where it is and is handed back to the console, never the smallest', () => {
    const { steps } = planned(entry('    version: "17"\n'), [appliedNative()]);

    expect(steps[0]).toMatchObject({
      action: 'change',
      fields: [
        {
          field: `${INSTANCE}.instance_class`,
          from: 'db.r7g.xlarge',
          to: 'db.r7g.xlarge',
          native: true,
          toConsole: true,
        },
      ],
      database: { instanceClass: null, native: null },
    });
  });

  it("plans the same file's size caps on a Server, where native.aws is checked only", () => {
    const outcome = planEnvironment({
      config: config(nativeClass('    size: medium\n')),
      saved: [],
      deployTarget: { kind: 'server', serverId: 'srv-1' },
      context: { previous: null },
    });

    if (!outcome.ok) throw new Error('refused');
    expect(outcome.steps[0]).toMatchObject({
      action: 'create',
      placement: { kind: 'server', serverId: 'srv-1' },
    });
    expect(outcome.steps[0]).not.toHaveProperty('database');
    expect(
      (outcome.steps[0] as unknown as { fields: { field: string }[] }).fields,
    ).toContainEqual({ field: 'size', from: null, to: 'medium' });
    expect(nativeLines(outcome.steps[0])).toEqual([]);
  });
});
