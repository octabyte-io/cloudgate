import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanInput,
  PlanOutcome,
  SavedService,
} from '../../src/project-config';

const CLOUD: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-1',
  region: 'eu-west-1',
};

const CONFIG = `version: 1
services:
  pg-1:
    kind: postgres
    version: "17"
    size: small
  web:
    kind: web
    source: { image: nginx }
    env: [{ DATABASE_URL: pg-1.url }]
`;

function plan(
  saved: SavedService[],
  extra: Partial<PlanInput> = {},
): PlanOutcome {
  const parsed = parseProjectConfig(CONFIG);
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal.message}`);
  return planEnvironment({
    config: parsed.config,
    saved,
    deployTarget: CLOUD,
    context: { previous: null },
    networks: [{ cloudAccountId: 'ca-1', region: 'eu-west-1' }],
    ...extra,
  });
}

function planned(saved: SavedService[], extra: Partial<PlanInput> = {}) {
  const outcome = plan(saved, extra);
  if (!outcome.ok) {
    throw new Error(
      `refused: ${outcome.refusals.map((r) => r.message).join('; ')}`,
    );
  }
  return outcome;
}

const settings = {
  description: null,
  cpuLimit: null,
  memoryLimit: null,
  dockerImage: 'postgres:17',
  databaseName: 'pg_1',
  databaseUser: 'pg_1',
};

/** `pg-1` on RDS, Cloudgate's own. */
const made: Extract<SavedService, { serviceType: 'postgres' }> = {
  serviceType: 'postgres',
  serviceId: 'pg-made',
  name: 'pg-1',
  configName: 'pg-1',
  cloud: { cloudAccountId: 'ca-1', region: 'eu-west-1', linkedRegistries: [] },
  rds: {
    instanceClass: null,
    storageGb: 20,
    maxStorageGb: 100,
    multiAz: false,
    backupRetentionDays: 7,
    applied: null,
  },
  settings,
  variables: { env: [] },
};

/** `pg-1` used as the existing database `acme-prod`. */
const existing: Extract<SavedService, { serviceType: 'postgres' }> = {
  serviceType: 'postgres',
  serviceId: 'pg-existing',
  name: 'pg-1',
  configName: 'pg-1',
  existing: {
    cloudAccountId: 'ca-1',
    region: 'eu-west-1',
    identifier: 'acme-prod',
    madeReachable: false,
  },
  settings,
  variables: { env: [] },
};

/** `web`, linking `pg-1.url`, on AWS. */
const web: SavedService = {
  serviceType: 'application',
  serviceId: 'web-id',
  name: 'web',
  configName: 'web',
  cloud: { cloudAccountId: 'ca-1', region: 'eu-west-1', linkedRegistries: [] },
  links: { DATABASE_URL: { source: 'pg-1', output: 'url' } },
  settings: {
    configKind: 'web',
    description: null,
    cpuLimit: null,
    memoryLimit: null,
    command: null,
    args: [],
    port: 3000,
    source: { image: 'nginx' },
    build: null,
    hasDomain: true,
  },
  variables: { env: [] },
} as unknown as SavedService;

const shape = (outcome: ReturnType<typeof planned>) =>
  outcome.steps.map((step) =>
    'configName' in step ? `${step.action}:${step.configName}` : step.action,
  );

const webStep = (outcome: ReturnType<typeof planned>) =>
  outcome.steps.find(
    (step) => 'configName' in step && step.configName === 'web',
  );

describe('planEnvironment, switching to or from an existing database (ADR-0033)', () => {
  it('plans a Cloudgate-made pg-1 switched to an existing one as a destroy and an add, saying no data is copied', () => {
    const outcome = planned([
      { ...made, switching: { to: 'existing', identifier: 'acme-prod' } },
      web,
    ]);

    expect(shape(outcome).filter((one) => one.endsWith(':pg-1'))).toEqual([
      'destroy:pg-1',
      'create:pg-1',
    ]);
    // pg-1 is re-created, so web, linking it, deploys again after it.
    expect(webStep(outcome)).toMatchObject({ because: ['pg-1.url'] });
    const [destroy, create] = outcome.steps;
    expect(destroy).toMatchObject({
      action: 'destroy',
      serviceId: 'pg-made',
      kind: 'postgres',
    });
    expect(destroy).not.toHaveProperty('existing');
    expect(create).toEqual({
      action: 'create',
      configName: 'pg-1',
      kind: 'postgres',
      placement: CLOUD,
      fields: [],
      existing: { identifier: 'acme-prod' },
    });
    expect(outcome.notes).toContainEqual({
      kind: 'data-not-copied',
      configName: 'pg-1',
      message:
        'pg-1: switches to the existing database acme-prod, which keeps its own data; no data is copied from the database Cloudgate made',
    });
    expect(outcome.notes).toContainEqual(
      expect.objectContaining({ kind: 'existing-not-applied' }),
    );
  });

  it('plans an existing pg-1 switched to a Cloudgate-made one as a records-only removal and a create on RDS', () => {
    const outcome = planned([
      { ...existing, switching: { to: 'made', identifier: null } },
      web,
    ]);

    expect(shape(outcome).filter((one) => one.endsWith(':pg-1'))).toEqual([
      'destroy:pg-1',
      'create:pg-1',
    ]);
    expect(webStep(outcome)).toMatchObject({ because: ['pg-1.url'] });
    const destroy = outcome.steps.find((step) => step.action === 'destroy');
    const create = outcome.steps.find(
      (step) => step.action === 'create' && step.configName === 'pg-1',
    );
    expect(destroy).toMatchObject({
      serviceId: 'pg-existing',
      existing: { identifier: 'acme-prod' },
    });
    expect(create).toMatchObject({
      action: 'create',
      kind: 'postgres',
      cloudRead: { status: 'reading' },
    });
    expect(create).not.toHaveProperty('existing');
    expect(outcome.notes).toContainEqual({
      kind: 'data-not-copied',
      configName: 'pg-1',
      message:
        'pg-1: the database Cloudgate makes starts empty; no data is copied from the existing database acme-prod, which is left as it was',
    });
  });

  it('plans as if none were asked for when a switch no longer fits', () => {
    const outcome = planned([
      { ...existing, switching: { to: 'existing', identifier: 'other' } },
    ]);

    expect(shape(outcome).filter((one) => one.endsWith(':pg-1'))).toEqual([
      'change:pg-1',
    ]);
  });

  it('creates the existing database once the Cloudgate-made one it replaces is gone', () => {
    const outcome = planned([web], {
      existingCreates: [
        { configName: 'pg-1', kind: 'postgres', identifier: 'acme-prod' },
      ],
    });

    expect(outcome.steps.find((step) => step.action === 'create')).toEqual({
      action: 'create',
      configName: 'pg-1',
      kind: 'postgres',
      placement: CLOUD,
      fields: [],
      existing: { identifier: 'acme-prod' },
    });
  });

  it('refuses a switch to an existing database off a Cloud account', () => {
    const parsed = parseProjectConfig(CONFIG);
    if (!parsed.ok) throw new Error('refused');
    const outcome = planEnvironment({
      config: parsed.config,
      saved: [
        {
          ...made,
          cloud: undefined,
          rds: undefined,
          switching: { to: 'existing', identifier: 'acme-prod' },
        },
      ],
      deployTarget: { kind: 'platform-host' },
      context: { previous: null },
    });

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.refusals[0].message).toContain(
      "pg-1 is to switch to the existing database acme-prod, which is looked up in the Environment's Cloud account",
    );
  });
});

const CACHE_CONFIG = `version: 1
services:
  cache:
    kind: redis
    version: "7"
    size: small
  web:
    kind: web
    source: { image: nginx }
    env: [{ REDIS_URL: cache.url }]
`;

function plannedCache(saved: SavedService[], extra: Partial<PlanInput> = {}) {
  const parsed = parseProjectConfig(CACHE_CONFIG);
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal.message}`);
  const outcome = planEnvironment({
    config: parsed.config,
    saved,
    deployTarget: CLOUD,
    context: { previous: null },
    networks: [{ cloudAccountId: 'ca-1', region: 'eu-west-1' }],
    ...extra,
  });
  if (!outcome.ok) {
    throw new Error(
      `refused: ${outcome.refusals.map((r) => r.message).join('; ')}`,
    );
  }
  return outcome;
}

const cacheSettings = {
  description: null,
  cpuLimit: null,
  memoryLimit: null,
  dockerImage: 'redis:7',
};

/** `cache` on ElastiCache, Cloudgate's own. */
const madeCache: Extract<SavedService, { serviceType: 'redis' }> = {
  serviceType: 'redis',
  serviceId: 'cache-made',
  name: 'cache',
  configName: 'cache',
  cloud: { cloudAccountId: 'ca-1', region: 'eu-west-1', linkedRegistries: [] },
  settings: cacheSettings,
  variables: { env: [] },
};

/** `cache` used as the existing replication group `acme-cache`. */
const existingCache: Extract<SavedService, { serviceType: 'redis' }> = {
  serviceType: 'redis',
  serviceId: 'cache-existing',
  name: 'cache',
  configName: 'cache',
  existing: {
    cloudAccountId: 'ca-1',
    region: 'eu-west-1',
    identifier: 'acme-cache',
    madeReachable: false,
  },
  settings: cacheSettings,
  variables: { env: [] },
};

/** `web`, linking `cache.url`, on AWS. */
const cacheWeb = {
  ...web,
  links: { REDIS_URL: { source: 'cache', output: 'url' } },
} as unknown as SavedService;

const cacheSteps = (outcome: ReturnType<typeof plannedCache>) =>
  outcome.steps.filter(
    (step) => 'configName' in step && step.configName === 'cache',
  );

describe('planEnvironment, switching a redis to or from an existing cache (ADR-0033)', () => {
  it('plans a Cloudgate-made cache switched to an existing one as a destroy and an add, saying no data is copied', () => {
    const outcome = plannedCache([
      { ...madeCache, switching: { to: 'existing', identifier: 'acme-cache' } },
      cacheWeb,
    ]);

    const [destroy, create] = cacheSteps(outcome);
    expect(destroy).toMatchObject({
      action: 'destroy',
      serviceId: 'cache-made',
      kind: 'redis',
    });
    expect(destroy).not.toHaveProperty('existing');
    expect(create).toEqual({
      action: 'create',
      configName: 'cache',
      kind: 'redis',
      placement: CLOUD,
      fields: [],
      existing: { identifier: 'acme-cache' },
    });
    expect(
      outcome.steps.find(
        (step) => 'configName' in step && step.configName === 'web',
      ),
    ).toMatchObject({ because: ['cache.url'] });
    expect(outcome.notes).toContainEqual({
      kind: 'data-not-copied',
      configName: 'cache',
      message:
        'cache: switches to the existing database acme-cache, which keeps its own data; no data is copied from the database Cloudgate made',
    });
  });

  it('plans an existing cache switched to a Cloudgate-made one as a records-only removal and a create on ElastiCache', () => {
    const outcome = plannedCache([
      { ...existingCache, switching: { to: 'made', identifier: null } },
      cacheWeb,
    ]);

    const [destroy, create] = cacheSteps(outcome);
    expect(destroy).toMatchObject({
      action: 'destroy',
      serviceId: 'cache-existing',
      existing: { identifier: 'acme-cache' },
    });
    expect(create).toMatchObject({
      action: 'create',
      kind: 'redis',
      cloudRead: { status: 'reading' },
    });
    expect(create).not.toHaveProperty('existing');
    expect(outcome.notes).toContainEqual({
      kind: 'data-not-copied',
      configName: 'cache',
      message:
        'cache: the database Cloudgate makes starts empty; no data is copied from the existing database acme-cache, which is left as it was',
    });
  });

  it('creates the existing cache once the Cloudgate-made one it replaces is gone', () => {
    const outcome = plannedCache([cacheWeb], {
      existingCreates: [
        { configName: 'cache', kind: 'redis', identifier: 'acme-cache' },
      ],
    });

    expect(cacheSteps(outcome)).toEqual([
      {
        action: 'create',
        configName: 'cache',
        kind: 'redis',
        placement: CLOUD,
        fields: [],
        existing: { identifier: 'acme-cache' },
      },
    ]);
  });

  it('never creates a postgres switch as the cache of the same Config name', () => {
    const outcome = plannedCache([cacheWeb], {
      existingCreates: [
        { configName: 'cache', kind: 'postgres', identifier: 'acme-prod' },
      ],
    });

    expect(cacheSteps(outcome)[0]).not.toHaveProperty('existing');
  });
});
