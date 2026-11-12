import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanOutcome,
  SavedService,
} from '../../src/project-config';

const CLOUD: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-1',
  region: 'eu-west-1',
};

function plan(
  text: string,
  saved: SavedService[] = [],
  networks = [{ cloudAccountId: 'ca-1', region: 'eu-west-1' }],
): PlanOutcome {
  const parsed = parseProjectConfig(text);
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal.message}`);
  return planEnvironment({
    config: parsed.config,
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
  `version: 1\nservices:\n  redis:\n    kind: redis\n${lines}`;

/** A redis already made on ElastiCache in this Environment. */
function onElastiCache(): Extract<SavedService, { serviceType: 'redis' }> {
  return {
    serviceType: 'redis',
    serviceId: 'redis-id',
    name: 'redis',
    configName: 'redis',
    cloud: {
      cloudAccountId: 'ca-1',
      region: 'eu-west-1',
      linkedRegistries: [],
    },
    settings: {
      description: null,
      cpuLimit: String(0.5e9),
      memoryLimit: String(1024 * 1024 * 1024),
      dockerImage: 'redis:7',
    },
    variables: { env: [] },
  };
}

describe('planEnvironment, a redis on an AWS Deploy target', () => {
  it('creates it as a Valkey replication group reading AWS, with its node type and version', () => {
    const { steps, notes } = planned(
      entry('    version: "7"\n    size: small\n'),
    );

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'create',
        configName: 'redis',
        kind: 'redis',
        placement: CLOUD,
        cache: {
          size: {
            name: 'small',
            nodeType: 'cache.t4g.small',
            machine: '2 vCPU, 1.37 GB',
            smallest: false,
          },
          version: {
            written: '7',
            engineVersion: '7.2',
            parameterFamily: 'valkey7',
          },
        },
        cloudRead: { status: 'reading' },
      }),
    ]);
    expect(notes).toContainEqual({
      kind: 'cloud-version-oldest',
      configName: 'redis',
      message: 'redis.version: redis 7 → Valkey 7.2 (oldest on AWS)',
    });
  });

  it('creates one with no size on cache.t4g.micro, the smallest, and version 8 on Valkey 8.1', () => {
    const { steps, notes } = planned(entry(''));

    expect(steps[0]).toMatchObject({
      cache: {
        size: { name: null, nodeType: 'cache.t4g.micro', smallest: true },
        version: { written: '8', engineVersion: '8.1' },
      },
    });
    expect(notes).toEqual([]);
  });

  it('makes the Environment network first where there is none', () => {
    const { steps } = planned(entry(''), [], []);

    expect(steps.map((step) => step.action)).toEqual([
      'network-create',
      'create',
    ]);
  });

  it('refuses a size above cache.m7g.2xlarge, naming it', () => {
    expect(refusals(entry('    size: { cpu: 16, memory: 64 GB }\n'))).toEqual([
      expect.objectContaining({
        at: 'redis.size',
        message: expect.stringContaining('cache.m7g.2xlarge') as string,
      }),
    ]);
  });

  it('refuses a version ElastiCache does not offer', () => {
    expect(refusals(entry('    version: "9"\n'))).toEqual([
      expect.objectContaining({ at: 'redis.version' }),
    ]);
  });

  it('plans a new size for one already on ElastiCache as a node-type change read from its state', () => {
    const { steps } = planned(entry('    version: "7"\n    size: medium\n'), [
      onElastiCache(),
    ]);

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'change',
        configName: 'redis',
        cache: {
          nodeType: {
            from: 'cache.t4g.small',
            to: 'cache.t4g.medium',
            machine: '2 vCPU, 3.09 GB',
            sizeName: 'medium',
          },
          version: null,
          settings: [],
        },
        cloudRead: { status: 'reading' },
      }),
    ]);
    expect(steps[0]).not.toHaveProperty('majorUpgrade');
  });

  it('notes a new size that lands on the node type it runs on, and reads no AWS', () => {
    const { steps, notes } = planned(
      entry('    version: "7"\n    size: { cpu: 1, memory: 1200 MB }\n'),
      [onElastiCache()],
    );

    expect(steps[0]).not.toHaveProperty('cache');
    expect(notes).toContainEqual(
      expect.objectContaining({
        kind: 'cloud-same-class',
        message: expect.stringContaining(
          'runs on cache.t4g.small either way: no change on AWS',
        ) as string,
      }),
    );
  });

  it('marks "7" → "8" as a major upgrade, on Valkey 8.1 with its own parameter family', () => {
    const { steps } = planned(entry('    version: "8"\n    size: small\n'), [
      onElastiCache(),
    ]);

    expect(steps[0]).toMatchObject({
      action: 'change',
      majorUpgrade: { from: '7', to: '8' },
      cache: {
        nodeType: null,
        version: {
          from: '7',
          to: '8',
          engineVersion: '8.1',
          parameterFamily: 'valkey8',
        },
      },
    });
  });

  it('refuses "8" → "7", naming the Valkey it runs', () => {
    const saved = onElastiCache();
    expect(
      refusals(entry('    version: "7"\n    size: small\n'), [
        {
          ...saved,
          settings: { ...saved.settings, dockerImage: 'redis:8' },
        },
      ]),
    ).toEqual([
      {
        at: 'redis.version',
        message:
          'redis.version: "7" is older than Valkey 8.1, which redis runs on ElastiCache, and ElastiCache cannot move a cache back to an older version; keep version: "8"',
      },
    ]);
  });

  it("plans the console's replica and snapshot retention against what the last Apply wrote", () => {
    const { steps } = planned(entry('    version: "7"\n    size: small\n'), [
      {
        ...onElastiCache(),
        elasticache: {
          nodeType: null,
          replica: true,
          snapshotRetentionDays: 0,
          applied: { nodeType: null, replica: false, snapshotRetentionDays: 1 },
        },
      },
    ]);

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'change',
        fields: [],
        cache: {
          nodeType: null,
          version: null,
          settings: [
            { setting: 'replica', from: false, to: true },
            { setting: 'snapshotRetentionDays', from: 1, to: 0 },
          ],
        },
      }),
    ]);
  });

  it("moves an entry with no size to the console's node type", () => {
    const saved = onElastiCache();
    const { steps } = planned(entry('    version: "7"\n'), [
      {
        ...saved,
        settings: { ...saved.settings, cpuLimit: null, memoryLimit: null },
        elasticache: {
          nodeType: 'cache.m7g.large',
          replica: false,
          snapshotRetentionDays: 1,
          applied: {
            nodeType: 'cache.t4g.micro',
            replica: false,
            snapshotRetentionDays: 1,
          },
        },
      },
    ]);

    expect(steps[0]).toMatchObject({
      cache: {
        nodeType: {
          from: 'cache.t4g.micro',
          to: 'cache.m7g.large',
          sizeName: null,
        },
      },
    });
  });

  it('lets a cloud web link its url, after it', () => {
    const { steps } = planned(
      `version: 1
services:
  web:
    kind: web
    port: 3000
    source: { image: "nginx:1.27" }
    env: [{ REDIS_URL: redis.url }]
  redis:
    kind: redis
`,
    );

    const names = steps
      .filter((step) => step.action === 'create')
      .map((step) => step.configName);
    expect(names).toEqual(['redis', 'web']);
  });
});

describe('planEnvironment, native.aws on a redis on ElastiCache', () => {
  const applied = {
    nodeType: null,
    replica: false,
    snapshotRetentionDays: 1,
  };
  const saved = (more: Partial<SavedService> = {}): SavedService =>
    ({
      ...onElastiCache(),
      elasticache: { ...applied, applied },
      ...more,
    }) as SavedService;
  const withNative = (address: string, lines: string) =>
    entry(
      `    version: "7"\n    size: small\n    native:\n      aws:\n        "${address}":\n${lines}`,
    );
  const PARAMETERS = 'aws_elasticache_parameter_group.valkey7';

  it("plans the parameter group's parameter as a native line, over Cloudgate's noeviction", () => {
    const { steps } = planned(
      withNative(
        PARAMETERS,
        '          parameter:\n            - { name: maxmemory-policy, value: allkeys-lru }\n',
      ),
      [saved()],
    );

    expect(steps).toEqual([
      expect.objectContaining({
        action: 'change',
        fields: [
          {
            field: `native.aws."${PARAMETERS}".parameter`,
            from: [{ name: 'maxmemory-policy', value: 'noeviction' }],
            to: [{ name: 'maxmemory-policy', value: 'allkeys-lru' }],
            native: true,
            fromDefault: true,
          },
        ],
        cache: {
          nodeType: null,
          version: null,
          settings: [],
          native: {
            [PARAMETERS]: {
              parameter: [{ name: 'maxmemory-policy', value: 'allkeys-lru' }],
            },
          },
        },
        cloudRead: { status: 'reading' },
      }),
    ]);
  });

  it('refuses a parameter group of a family its version does not run, naming the one it does', () => {
    expect(
      refusals(
        withNative(
          'aws_elasticache_parameter_group.valkey8',
          '          parameter: []\n',
        ),
        [saved()],
      ).map((one) => one.message),
    ).toEqual([
      expect.stringContaining(
        'its version runs valkey7, so its parameter group is aws_elasticache_parameter_group.valkey7',
      ),
    ]);
  });

  it("plans the replicas and snapshot days over the console's, handed back where they are once taken out", () => {
    const set = planned(
      withNative(
        'aws_elasticache_replication_group.cache',
        '          num_cache_clusters: 2\n          snapshot_retention_limit: 5\n',
      ),
      [saved()],
    );
    const GROUP = 'native.aws."aws_elasticache_replication_group.cache"';

    expect(set.steps[0]).toMatchObject({
      action: 'change',
      fields: [
        {
          field: `${GROUP}.num_cache_clusters`,
          from: 1,
          to: 2,
          native: true,
          fromConsole: true,
        },
        {
          field: `${GROUP}.snapshot_retention_limit`,
          from: 1,
          to: 5,
          native: true,
          fromConsole: true,
        },
      ],
    });

    // Its Apply wrote both to the console's columns.
    const kept = { ...applied, replica: true, snapshotRetentionDays: 5 };
    const removed = planned(entry('    version: "7"\n    size: small\n'), [
      saved({
        elasticache: { ...kept, applied: kept },
        nativeAws: {
          'aws_elasticache_replication_group.cache': {
            num_cache_clusters: 2,
            snapshot_retention_limit: 5,
          },
        },
      }),
    ]);

    expect(removed.steps[0]).toMatchObject({
      action: 'change',
      fields: [
        {
          field: `${GROUP}.num_cache_clusters`,
          from: 2,
          to: 2,
          toConsole: true,
        },
        {
          field: `${GROUP}.snapshot_retention_limit`,
          from: 5,
          to: 5,
          toConsole: true,
        },
      ],
      cache: { settings: [], native: null },
    });
  });
});

describe('planEnvironment, an exact node type on ElastiCache: native.aws node_type wins over size', () => {
  const GROUP = 'native.aws."aws_elasticache_replication_group.cache"';
  const console = { nodeType: null, replica: false, snapshotRetentionDays: 1 };
  const nativeType = (size: string) =>
    entry(
      `    version: "7"\n${size}    native:\n      aws:\n        "aws_elasticache_replication_group.cache":\n          node_type: cache.r7g.large\n`,
    );
  const appliedNative = (): SavedService => ({
    ...onElastiCache(),
    elasticache: {
      ...console,
      nodeType: 'cache.r7g.large',
      applied: { ...console, nodeType: 'cache.r7g.large' },
    },
    nativeAws: {
      'aws_elasticache_replication_group.cache': {
        node_type: 'cache.r7g.large',
      },
    },
  });

  it('creates it on the native node type, beside the size it gives way to', () => {
    const { steps } = planned(nativeType('    size: small\n'));

    expect(steps[0]).toMatchObject({
      action: 'create',
      cache: {
        size: {
          name: 'small',
          nodeType: 'cache.r7g.large',
          machine: '2 vCPU, 13.07 GB',
          smallest: false,
          native: true,
        },
      },
    });
  });

  it('moves a made group to the native node type, marked native', () => {
    const saved = {
      ...onElastiCache(),
      elasticache: { ...console, applied: console },
    } as SavedService;

    const { steps } = planned(nativeType('    size: small\n'), [saved]);

    expect(steps[0]).toMatchObject({
      action: 'change',
      fields: [
        {
          field: `${GROUP}.node_type`,
          from: 'cache.t4g.small',
          to: 'cache.r7g.large',
          fromSize: true,
        },
      ],
      cache: {
        nodeType: {
          from: 'cache.t4g.small',
          to: 'cache.r7g.large',
          machine: '2 vCPU, 13.07 GB',
          sizeName: 'small',
          native: true,
        },
      },
    });
  });

  it("taken out, falls back to the size's node type, or with no size stays where it is", () => {
    const sized = planned(entry('    version: "7"\n    size: small\n'), [
      appliedNative(),
    ]);
    expect(sized.steps[0]).toMatchObject({
      fields: [
        {
          field: `${GROUP}.node_type`,
          from: 'cache.r7g.large',
          to: 'cache.t4g.small',
          toSize: true,
        },
      ],
      cache: {
        nodeType: { from: 'cache.r7g.large', to: 'cache.t4g.small' },
        native: null,
      },
    });

    const unsized = planned(entry('    version: "7"\n'), [appliedNative()]);
    expect(unsized.steps[0]).toMatchObject({
      fields: [
        {
          field: `${GROUP}.node_type`,
          from: 'cache.r7g.large',
          to: 'cache.r7g.large',
          toConsole: true,
        },
      ],
      cache: { nodeType: null, native: null },
    });
  });
});
