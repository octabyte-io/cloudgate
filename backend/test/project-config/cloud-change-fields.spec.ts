import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanOutcome,
  SavedService,
} from '../../src/project-config';
import { fixedWhenMadeRefusals } from '../../src/project-config/planner/cloud-change-fields';
import type {
  CloudChangeField,
  CloudChangeFields,
} from '../../src/project-config/planner/cloud-change-fields';
import { RDS_CHANGE_FIELDS } from '../../src/project-config/planner/cloud-postgres';
import { ELASTICACHE_CHANGE_FIELDS } from '../../src/project-config/planner/cloud-redis';
import { CLOUD_SQL_CHANGE_FIELDS } from '../../src/project-config/planner/cloud-sql';
import { MEMORYSTORE_CHANGE_FIELDS } from '../../src/project-config/planner/memorystore';
import { FIELDS } from '../../src/project-config/planner/plan-environment';

/**
 * The census of "a cloud database change planner silently passes a saved
 * field through to the row": Cloud SQL's planner never read `user`
 * or `database`, so a change to either planned as a row edit Google never
 * saw. Every cloud database change planner states, for each field its kind
 * compares, whether it moves the instance, is Cloudgate's alone, or is fixed
 * when it is made and refused; and each statement is checked against what
 * the planner does with a change to that one field. A field added to
 * `FIELDS` fails here until each planner states it, a planner that ignores a
 * field it says it moves or refuses fails, and the one field Cloudgate keeps
 * to itself is named below, so a field the planner ignores cannot pass as
 * Cloudgate's.
 */

type CloudTarget = Extract<DeployTarget, { kind: 'cloud' }>;

const AWS: CloudTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-1',
  region: 'eu-west-1',
};
const GOOGLE: CloudTarget = {
  kind: 'cloud',
  cloudAccountId: 'gca-1',
  region: 'europe-west1',
};

/** The one field a plan compares that no cloud database reads. */
const CLOUDGATE_ALONE = ['description'];

type DatabaseKind = 'postgres' | 'mysql' | 'redis';

/** Where a change step carries each planner's move. */
type MoveKey = 'database' | 'cloudSql' | 'cache' | 'memorystore';

interface Planner {
  readonly name: string;
  readonly kind: DatabaseKind;
  readonly target: CloudTarget;
  readonly changeFields: CloudChangeFields;
  readonly moveKey: MoveKey;
  /** The made instance, its settings as `base` writes them. */
  readonly saved: SavedService;
  /** The entry's lines that change nothing on `saved`. */
  readonly base: Readonly<Record<string, string>>;
  /** For each field, a value that differs from `base`'s. */
  readonly changed: Readonly<Record<string, string>>;
}

const settings = (image: string, withLogin: boolean) => ({
  description: null,
  cpuLimit: String(0.5e9),
  memoryLimit: String(1024 * 1024 * 1024),
  dockerImage: image,
  ...(withLogin ? { databaseName: 'db_1', databaseUser: 'db_1' } : {}),
});

const awsCloud = {
  cloudAccountId: 'ca-1',
  region: 'eu-west-1',
  linkedRegistries: [],
};
const gcpCloud = {
  cloudAccountId: 'gca-1',
  region: 'europe-west1',
  cloud: 'gcp' as const,
  linkedRegistries: [],
};

const made = (
  kind: DatabaseKind,
  cloud: typeof awsCloud | typeof gcpCloud,
  image: string,
  extra: Partial<SavedService> = {},
): SavedService =>
  ({
    serviceType: kind,
    serviceId: 'db-id',
    name: 'db-1',
    configName: 'db-1',
    cloud,
    settings: settings(image, kind !== 'redis'),
    variables: { env: [] },
    ...extra,
  }) as SavedService;

const LOGIN = { database: 'db_1', user: 'db_1' };
const NEW_LOGIN = { database: 'other', user: 'other' };

const PLANNERS: readonly Planner[] = [
  {
    name: 'RDS',
    kind: 'postgres',
    target: AWS,
    changeFields: RDS_CHANGE_FIELDS,
    moveKey: 'database',
    saved: made('postgres', awsCloud, 'postgres:16'),
    base: { size: 'small', version: '"16"', ...LOGIN },
    changed: {
      description: 'orders',
      size: 'large',
      version: '"17"',
      ...NEW_LOGIN,
    },
  },
  {
    name: 'RDS',
    kind: 'mysql',
    target: AWS,
    changeFields: RDS_CHANGE_FIELDS,
    moveKey: 'database',
    saved: made('mysql', awsCloud, 'mysql:8.4'),
    base: { size: 'small', version: '"8.4"', ...LOGIN },
    changed: {
      description: 'orders',
      size: 'large',
      version: '"8.4.6"',
      ...NEW_LOGIN,
    },
  },
  {
    name: 'Cloud SQL',
    kind: 'postgres',
    target: GOOGLE,
    changeFields: CLOUD_SQL_CHANGE_FIELDS,
    moveKey: 'cloudSql',
    saved: made('postgres', gcpCloud, 'postgres:16'),
    base: { size: 'small', version: '"16"', ...LOGIN },
    changed: {
      description: 'orders',
      size: 'large',
      version: '"17"',
      ...NEW_LOGIN,
    },
  },
  {
    name: 'Cloud SQL',
    kind: 'mysql',
    target: GOOGLE,
    changeFields: CLOUD_SQL_CHANGE_FIELDS,
    moveKey: 'cloudSql',
    saved: made('mysql', gcpCloud, 'mysql:8.4'),
    base: { size: 'small', version: '"8.4"', ...LOGIN },
    // Cloud SQL offers one MySQL major, 8.4, and no pinned minor, so a
    // version change is checked by its rules and refused, never moved.
    changed: {
      description: 'orders',
      size: 'large',
      version: '"9.7"',
      ...NEW_LOGIN,
    },
  },
  {
    name: 'ElastiCache',
    kind: 'redis',
    target: AWS,
    changeFields: ELASTICACHE_CHANGE_FIELDS,
    moveKey: 'cache',
    saved: made('redis', awsCloud, 'redis:7'),
    base: { size: 'small', version: '"7"' },
    changed: { description: 'sessions', size: 'large', version: '"8"' },
  },
  {
    name: 'Memorystore',
    kind: 'redis',
    target: GOOGLE,
    changeFields: MEMORYSTORE_CHANGE_FIELDS,
    moveKey: 'memorystore',
    saved: made('redis', gcpCloud, 'redis:8', {
      memorystore: {
        highAvailability: false,
        backupRetentionDays: 1,
        applied: { highAvailability: false, backupRetentionDays: 1 },
        engineVersion: null,
      },
    }),
    base: { size: 'small', version: '"8"' },
    changed: { description: 'sessions', size: 'large', version: '"9"' },
  },
];

function plan(planner: Planner, lines: Record<string, string>): PlanOutcome {
  const text = `version: 1\nservices:\n  db-1:\n    kind: ${planner.kind}\n${Object.entries(
    lines,
  )
    .map(([field, value]) => `    ${field}: ${value}\n`)
    .join('')}`;
  const parsed = parseProjectConfig(text);
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal.message}`);
  return planEnvironment({
    config: parsed.config,
    saved: [planner.saved],
    deployTarget: planner.target,
    cloud: planner.target === GOOGLE ? 'gcp' : 'aws',
    context: { previous: null },
    networks: [
      {
        cloudAccountId: planner.target.cloudAccountId,
        region: planner.target.region,
      },
    ],
  });
}

/**
 * What the planner did with a change to `field` alone, in the table's words:
 * refused as fixed when it is made (`fixed`); moved the instance, or
 * checked the move by its cloud's own rules and refused it (`moves`);
 * or nothing, leaving the change to the row (`row`).
 */
function observed(planner: Planner, field: string): CloudChangeField {
  const outcome = plan(planner, {
    ...planner.base,
    [field]: planner.changed[field],
  });
  if (!outcome.ok) {
    const at = outcome.refusals.filter((one) => one.at === `db-1.${field}`);
    if (at.length !== outcome.refusals.length) {
      throw new Error(
        `refused another field: ${outcome.refusals.map((one) => one.message).join('; ')}`,
      );
    }
    return at.every((one) => one.message.includes('is fixed when it is made'))
      ? 'fixed'
      : 'moves';
  }
  const step = outcome.steps.find((one) => one.action === 'change');
  if (!step || step.action !== 'change') {
    throw new Error(`no change step for a change to ${field}`);
  }
  return step[planner.moveKey] || step.majorUpgrade ? 'moves' : 'row';
}

const EACH = PLANNERS.map((one) => [one.name, one.kind, one] as const);

describe('CloudChangeFields', () => {
  it.each(EACH)(
    '%s states what it does with every %s field, and no other',
    (_, kind, planner) => {
      expect(Object.keys(planner.changeFields).sort()).toEqual(
        [...FIELDS[kind]].sort(),
      );
    },
  );

  it.each(EACH)(
    "%s's %s plans nothing for a config that changes nothing",
    (_, __, planner) => {
      const outcome = plan(planner, planner.base);
      if (!outcome.ok) throw new Error('refused');
      expect(outcome.steps).toEqual([]);
    },
  );

  it.each(EACH)(
    '%s does to a %s what it states for a change to each field',
    (_, kind, planner) => {
      const done = Object.fromEntries(
        FIELDS[kind].map((field) => [field, observed(planner, field)]),
      );
      expect(done).toEqual(planner.changeFields);
    },
  );

  it.each(EACH)(
    '%s keeps only the description of a %s to Cloudgate alone',
    (_, __, planner) => {
      expect(
        Object.entries(planner.changeFields)
          .filter(([, does]) => does === 'row')
          .map(([field]) => field),
      ).toEqual(CLOUDGATE_ALONE);
    },
  );
});

describe('fixedWhenMadeRefusals', () => {
  const diffs = [
    { field: 'size', from: 'small', to: 'large' },
    { field: 'database', from: 'db_1', to: 'other' },
    { field: 'user', from: 'db_1', to: 'root' },
  ];

  it('refuses a user or database change on RDS and on Cloud SQL alike, each in its own words, and nothing else', () => {
    expect(
      fixedWhenMadeRefusals('db-1', diffs, RDS_CHANGE_FIELDS, 'RDS'),
    ).toEqual([
      {
        at: 'db-1.database',
        message:
          "db-1.database: an RDS instance's initial database is fixed when it is made; keep database: db_1",
      },
      {
        at: 'db-1.user',
        message:
          "db-1.user: an RDS instance's master user is fixed when it is made; keep user: db_1",
      },
    ]);
    expect(
      fixedWhenMadeRefusals(
        'db-1',
        diffs,
        CLOUD_SQL_CHANGE_FIELDS,
        'Cloud SQL',
      ),
    ).toEqual([
      {
        at: 'db-1.database',
        message:
          "db-1.database: a Cloud SQL instance's database is fixed when it is made; keep database: db_1",
      },
      {
        at: 'db-1.user',
        message:
          "db-1.user: a Cloud SQL instance's user is fixed when it is made; keep user: db_1",
      },
    ]);
  });
});
