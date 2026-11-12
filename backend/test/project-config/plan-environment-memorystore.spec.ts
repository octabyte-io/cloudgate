import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanOutcome,
  SavedService,
} from '../../src/project-config';

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
  `version: 1\nservices:\n  redis:\n    kind: redis\n${lines}`;

/** The one create step a plan of `entry(lines)` makes. */
function created(lines: string) {
  const [step] = planned(entry(lines)).steps;
  if (step.action !== 'create') throw new Error(`a ${step.action}`);
  return step;
}

/**
 * A redis already made on Memorystore in this Environment, its high
 * availability on the console and as its last Apply wrote it (`null`: as
 * the console holds it), and the engine version its Apply made it with
 * (`null`: read from its written version).
 */
function onMemorystore(
  size: { cpu: number; memoryMb: number } | null,
  version = '8',
  highAvailability = false,
  appliedHighAvailability: boolean | null = null,
  engineVersion: string | null = null,
): Extract<SavedService, { serviceType: 'redis' }> {
  return {
    serviceType: 'redis',
    serviceId: 'redis-id',
    name: 'redis',
    configName: 'redis',
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
      dockerImage: `redis:${version}`,
    },
    memorystore: {
      highAvailability,
      backupRetentionDays: 1,
      // Made with backups, a day of them as its Apply wrote.
      applied: {
        highAvailability: appliedHighAvailability ?? highAvailability,
        backupRetentionDays: 1,
      },
      engineVersion,
    },
    variables: { env: [] },
  };
}

/** The one change step a plan of `entry(lines)` over `saved` makes. */
function changed(lines: string, saved: SavedService) {
  const outcome = planned(entry(lines), [saved]);
  const step = outcome.steps.find((one) => one.action === 'change');
  if (!step || step.action !== 'change') throw new Error('no change');
  return { step, notes: outcome.notes };
}

describe('planEnvironment, a redis on a Google Cloud Deploy target', () => {
  describe('size → Valkey node type, by memory only', () => {
    it.each([
      ['xsmall', 'CUSTOM_PICO'],
      ['small', 'CUSTOM_PICO'],
      ['medium', 'CUSTOM_MICRO'],
      ['large', 'STANDARD_SMALL'],
      ['xlarge', 'HIGHMEM_MEDIUM'],
      ['2xlarge', 'STANDARD_LARGE'],
    ])('puts %s on %s', (size, nodeType) => {
      expect(created(`    size: ${size}\n`).memorystore?.size).toMatchObject({
        name: size,
        nodeType,
        smallest: false,
      });
    });

    it.each([
      ['{ cpu: 0.25, memory: 2.5 GB }', 'CUSTOM_MINI'],
      ['{ cpu: 16, memory: 2 GB }', 'CUSTOM_MICRO'],
      ['{ cpu: 1, memory: 40 GB }', 'HIGHMEM_XLARGE'],
      ['{ cpu: 1, memory: 88 GB }', 'HIGHMEM_2XLARGE'],
    ])('puts the custom size %s on %s', (size, nodeType) => {
      expect(created(`    size: ${size}\n`).memorystore?.size).toMatchObject({
        name: null,
        nodeType,
      });
    });

    it('never picks shared-core-nano or highcpu-medium', () => {
      const picked = ['512 MB', '1 GB', '1100 MB', '10 GB'].map(
        (memory) =>
          created(`    size: { cpu: 0.25, memory: ${memory} }\n`).memorystore
            ?.size.nodeType,
      );

      expect(picked).toEqual([
        'CUSTOM_PICO',
        'CUSTOM_PICO',
        'CUSTOM_PICO',
        'HIGHMEM_MEDIUM',
      ]);
    });

    it('creates one with no size on custom-pico, the smallest, as one node', () => {
      expect(created('').memorystore).toMatchObject({
        size: {
          name: null,
          nodeType: 'CUSTOM_PICO',
          writableMemory: '1.08 GB',
          smallest: true,
        },
        nodes: 1,
      });
    });

    it('refuses a size above highmem-2xlarge, naming it', () => {
      expect(refusals(entry('    size: { cpu: 1, memory: 89 GB }\n'))).toEqual([
        {
          at: 'redis.size',
          message: expect.stringContaining(
            'above the largest Memorystore node type Cloudgate chooses, highmem-2xlarge (88 GB)',
          ) as unknown,
        },
      ]);
    });
  });

  describe('plan lines', () => {
    it('names the node type, its writable memory and one node', () => {
      expect(created('    size: small\n').memorystore?.lines).toEqual([
        'redis small → custom-pico (1.08 GB, 1 node)',
        'redis backups: 1 day',
      ]);
    });

    it('names the smallest node type an entry with no size gets', () => {
      expect(created('').memorystore?.lines).toEqual([
        'redis no size → custom-pico (smallest: 1.08 GB, 1 node)',
        'redis backups: 1 day',
      ]);
    });

    it('counts two nodes when high availability is on', () => {
      const { step } = changed(
        '    version: "8"\n    size: medium\n',
        onMemorystore({ cpu: 0.5, memoryMb: 1024 }, '8', true),
      );

      expect(step.memorystore?.lines).toContain(
        'redis medium → custom-micro (2 GB, 2 nodes), from custom-pico',
      );
    });
  });

  it('is read from Google Cloud as a Memorystore instance, never through an ElastiCache definition', () => {
    const step = created('    size: small\n');

    expect(step.cache).toBeUndefined();
    expect(step.cloudRead).toEqual({ status: 'reading' });
  });

  describe("the Environment network's private link", () => {
    function steps(
      text: string,
      networks: Parameters<typeof planEnvironment>[0]['networks'],
    ) {
      const parsed = parseProjectConfig(text);
      if (!parsed.ok) throw new Error('refused');
      const outcome = planEnvironment({
        config: parsed.config,
        saved: [],
        deployTarget: GOOGLE,
        cloud: 'gcp',
        context: { previous: null },
        networks,
      });
      if (!outcome.ok) throw new Error('refused');
      return outcome.steps;
    }
    const MADE = {
      cloudAccountId: 'gca-1',
      region: 'europe-west1',
      environmentNetworkId: 'net-1',
    };
    const ALL = `version: 1\nservices:\n  web:\n    kind: web\n    source: { image: nginx }\n  pg-1:\n    kind: postgres\n  redis:\n    kind: redis\n`;

    it('makes the Environment network first where there is none, with Memorystore’s private link', () => {
      const [network] = steps(entry(''), []);

      expect(network).toEqual({
        action: 'network-create',
        cloudAccountId: 'gca-1',
        region: 'europe-west1',
        privateLinks: ['memorystore'],
        cloudRead: { status: 'reading' },
      });
    });

    it('makes both kinds’ links with the network when one plan creates a postgres and a redis', () => {
      expect(steps(ALL, [])[0]).toMatchObject({
        action: 'network-create',
        privateLinks: ['cloud-sql', 'memorystore'],
      });
    });

    it('adds Memorystore’s link to a made network that has only Cloud SQL’s, as a network change of its own, first', () => {
      const [network, create] = steps(entry(''), [
        { ...MADE, privateLinks: ['cloud-sql'] },
      ]);

      expect(network).toEqual({
        action: 'network-change',
        environmentNetworkId: 'net-1',
        cloudAccountId: 'gca-1',
        region: 'europe-west1',
        privateLinks: ['memorystore'],
        cloudRead: { status: 'reading' },
      });
      expect(create).toMatchObject({ action: 'create', configName: 'redis' });
    });

    it('adds no second link when the network has it already', () => {
      expect(
        steps(entry(''), [{ ...MADE, privateLinks: ['memorystore'] }]).map(
          (step) => step.action,
        ),
      ).toEqual(['create']);
    });
  });

  describe('Valkey version', () => {
    it('gives a major alone the newest minor at create, keeping the major, and notes once that Memorystore never moves minors', () => {
      const text = `version: 1
services:
  redis:
    kind: redis
    version: "9"
  queue:
    kind: redis
    version: "8"
`;
      const { steps, notes } = planned(text);

      expect(
        steps.map((step) => 'memorystore' in step && step.memorystore?.version),
      ).toEqual([
        { written: '9', engineVersion: 'VALKEY_9_1' },
        { written: '8', engineVersion: 'VALKEY_8_0' },
      ]);
      expect(
        notes.filter((note) => note.kind === 'cloud-version-minor'),
      ).toEqual([
        {
          kind: 'cloud-version-minor',
          configName: 'redis',
          message:
            'redis.version: Memorystore never moves a cache to a newer Valkey minor by itself; a version that names only its major keeps the minor it was made on',
        },
      ]);
    });

    it('runs 6 as Valkey 7.2, the oldest on GCP, with a note', () => {
      const { steps, notes } = planned(entry('    version: "6"\n'));

      expect(steps[0]).toMatchObject({
        memorystore: { version: { written: '6', engineVersion: 'VALKEY_7_2' } },
      });
      expect(notes).toContainEqual({
        kind: 'cloud-version-oldest',
        configName: 'redis',
        message: 'redis.version: redis 6 → Valkey 7.2 (oldest on GCP)',
      });
    });

    it('drops an image suffix, with a note', () => {
      const { steps, notes } = planned(entry('    version: 8-alpine\n'));

      expect(steps[0]).toMatchObject({
        memorystore: { version: { engineVersion: 'VALKEY_8_0' } },
      });
      expect(notes).toContainEqual({
        kind: 'cloud-version-suffix',
        configName: 'redis',
        message:
          'redis.version: 8-alpine runs as Valkey 8.0 on Memorystore; the image suffix -alpine is dropped',
      });
    });

    it('refuses a minor GCP lacks, naming the ones it offers', () => {
      expect(refusals(entry('    version: "8.1"\n'))).toEqual([
        {
          at: 'redis.version',
          message:
            'redis.version: 8.1 is not offered by Memorystore for Valkey; it offers 7.2, 8.0, 9.0, 9.1',
        },
      ]);
    });

    it('refuses a major GCP does not offer', () => {
      expect(refusals(entry('    version: "10"\n'))).toEqual([
        {
          at: 'redis.version',
          message:
            'redis.version: 10 is not offered by Memorystore for Valkey; it offers 7.2, 8.0, 9.0, 9.1',
        },
      ]);
    });
  });

  describe('a change to one on Memorystore', () => {
    it('shows xsmall → small as no change on GCP', () => {
      const { step, notes } = changed(
        '    version: "8"\n    size: small\n',
        onMemorystore({ cpu: 0.25, memoryMb: 512 }),
      );

      expect(step.memorystore).toBeUndefined();
      expect(notes).toContainEqual({
        kind: 'cloud-same-class',
        configName: 'redis',
        message:
          'redis.size: xsmall → small runs on custom-pico either way: no change on GCP',
      });
    });

    it('marks a node type change as a resize that may drop connections', () => {
      const { step } = changed(
        '    version: "8"\n    size: large\n',
        onMemorystore({ cpu: 1, memoryMb: 2048 }),
      );

      expect(step.memorystore).toEqual({
        nodeType: {
          from: 'CUSTOM_MICRO',
          to: 'STANDARD_SMALL',
          writableMemory: '5.2 GB',
          sizeName: 'large',
        },
        version: null,
        highAvailability: null,
        lines: [
          'redis large → standard-small (5.2 GB, 1 node), from custom-micro',
          'redis: may drop connections briefly while it resizes',
        ],
      });
      expect(step.cloudRead).toEqual({ status: 'reading' });
    });

    it('shows a major upgrade apart, for Apply’s confirmation', () => {
      const { step } = changed('    version: "9"\n', onMemorystore(null, '8'));

      expect(step.majorUpgrade).toEqual({ from: '8', to: '9' });
      expect(step.memorystore).toEqual({
        nodeType: null,
        version: { from: '8', to: '9', engineVersion: 'VALKEY_9_1' },
        highAvailability: null,
        lines: [
          'major upgrade 8 → 9: may drop connections briefly, cannot be undone',
        ],
      });
    });

    it('refuses a downgrade, naming the Valkey it runs', () => {
      expect(
        refusals(entry('    version: "8"\n'), [onMemorystore(null, '9')]),
      ).toEqual([
        {
          at: 'redis.version',
          message:
            'redis.version: "8" is older than Valkey 9.1, which redis runs on Memorystore, and Memorystore cannot move a cache back to an older version; keep version: "9"',
        },
      ]);
    });
  });

  describe('a major alone, made on an older minor than Google now offers', () => {
    const madeOnNineZero = onMemorystore(null, '9', false, null, 'VALKEY_9_0');

    it('plans nothing while the config still names only the major', () => {
      expect(
        planned(entry('    version: "9"\n'), [madeOnNineZero]).steps,
      ).toEqual([]);
    });

    it('reads a version change against the minor it runs, not the newest', () => {
      const { step } = changed('    version: "9.1"\n', madeOnNineZero);

      expect(step.majorUpgrade).toBeUndefined();
      expect(step.memorystore).toEqual({
        nodeType: null,
        version: { from: '9', to: '9.1', engineVersion: 'VALKEY_9_1' },
        highAvailability: null,
        lines: ['redis version: Valkey 9.0 → 9.1'],
      });
    });

    it('refuses a pin older than the minor it runs', () => {
      expect(
        refusals(entry('    version: "9.0"\n'), [
          onMemorystore(null, '9.1', false, null, 'VALKEY_9_1'),
        ]),
      ).toEqual([
        {
          at: 'redis.version',
          message:
            'redis.version: "9.0" is older than Valkey 9.1, which redis runs on Memorystore, and Memorystore cannot move a cache back to an older version; keep version: "9.1"',
        },
      ]);
    });
  });

  describe('high availability, the console’s setting', () => {
    it('plans the replica added in place when it was turned on since the last Apply, naming two nodes', () => {
      const { step } = changed(
        '    version: "8"\n    size: small\n',
        onMemorystore({ cpu: 0.5, memoryMb: 1024 }, '8', true, false),
      );

      expect(step.fields).toEqual([]);
      expect(step.memorystore).toEqual({
        nodeType: null,
        version: null,
        highAvailability: { from: false, to: true },
        lines: [
          'redis small → custom-pico (1.08 GB, 2 nodes), from 1 node',
          'redis high availability: off → on, one replica in another zone, added in place; about double the node cost',
        ],
      });
      expect(step.cloudRead).toEqual({ status: 'reading' });
    });

    it('plans the replica removed when it was turned off again', () => {
      const { step } = changed(
        '    version: "8"\n    size: small\n',
        onMemorystore({ cpu: 0.5, memoryMb: 1024 }, '8', false, true),
      );

      expect(step.memorystore).toMatchObject({
        highAvailability: { from: true, to: false },
        lines: [
          'redis small → custom-pico (1.08 GB, 1 node), from 2 nodes',
          'redis high availability: on → off, its replica removed in place; one node',
        ],
      });
    });

    it('names both moves in one line when the size moves too', () => {
      const { step } = changed(
        '    version: "8"\n    size: medium\n',
        onMemorystore({ cpu: 0.5, memoryMb: 1024 }, '8', true, false),
      );

      expect(step.memorystore?.lines).toEqual([
        'redis medium → custom-micro (2 GB, 2 nodes), from custom-pico, 1 node',
        'redis: may drop connections briefly while it resizes',
        'redis high availability: off → on, one replica in another zone, added in place; about double the node cost',
      ]);
    });

    it('plans nothing when the console holds what the last Apply wrote', () => {
      const outcome = planned(entry('    version: "8"\n    size: small\n'), [
        onMemorystore({ cpu: 0.5, memoryMb: 1024 }, '8', true, true),
      ]);

      expect(outcome.steps).toEqual([]);
    });

    it('creates a new one with one node: the config never turns it on', () => {
      expect(created('    size: small\n').memorystore?.nodes).toBe(1);
    });
  });

  describe('backups', () => {
    /**
     * `redis` on Memorystore with its Backups tab's retention, and the one
     * its last Apply wrote (`null`: made before backups).
     */
    function backedUp(
      backupRetentionDays: number,
      applied: number | null,
    ): Extract<SavedService, { serviceType: 'redis' }> {
      const saved = onMemorystore({ cpu: 0.5, memoryMb: 1024 }, '8');
      return {
        ...saved,
        memorystore: {
          ...saved.memorystore!,
          backupRetentionDays,
          applied: {
            highAvailability: false,
            ...(applied === null ? {} : { backupRetentionDays: applied }),
          },
        },
      };
    }
    const SAME = '    version: "8"\n    size: small\n';

    it('makes a new one keeping a day of backups', () => {
      expect(created('    size: small\n').memorystore).toMatchObject({
        backupRetentionDays: 1,
        lines: expect.arrayContaining(['redis backups: 1 day']) as unknown,
      });
    });

    it.each([
      [0, 1, 'redis backups: 1 day → off'],
      [365, 1, 'redis backups: 1 day → 365 days'],
      [3, 0, 'redis backups: off → 3 days'],
    ])(
      'plans a retention of %i days edited on its Backups tab as a change, from %i',
      (days, applied, line) => {
        const { step } = changed(SAME, backedUp(days, applied));

        expect(step.fields).toEqual([]);
        expect(step.memorystore).toEqual({
          nodeType: null,
          version: null,
          highAvailability: null,
          backupRetentionDays: { from: applied, to: days },
          lines: [line],
        });
        expect(step.cloudRead).toEqual({ status: 'reading' });
      },
    );

    it('plans nothing when its Backups tab holds what the last Apply wrote', () => {
      expect(planned(entry(SAME), [backedUp(5, 5)]).steps).toEqual([]);
    });

    it('catches one made before backups up: its retention planned from off, in place with no restart mark', () => {
      const { step } = changed(SAME, backedUp(1, null));

      expect(step.memorystore).toEqual({
        nodeType: null,
        version: null,
        highAvailability: null,
        backupRetentionDays: { from: 0, to: 1 },
        lines: ['redis backups: off → 1 day'],
      });
      expect(step.cloudRead).toEqual({ status: 'reading' });
    });

    it('leaves one made before backups whose Backups tab holds them off as it is', () => {
      expect(planned(entry(SAME), [backedUp(0, null)]).steps).toEqual([]);
    });

    it('refuses a retention above 365 days', () => {
      expect(refusals(entry(SAME), [backedUp(366, 1)])).toEqual([
        {
          at: 'redis',
          message:
            "redis: a backup retention of 366 days is outside Memorystore's 0 to 365 days; set one on redis's Backups tab",
        },
      ]);
    });
  });

  describe('a web linking its password (ADR-0042)', () => {
    const webAndRedis = `version: 1
services:
  web:
    kind: web
    size: small
    source: { image: nginx }
    env:
      - REDIS_URL: redis.url
      - REDIS_PASSWORD: redis.password
  redis:
    kind: redis
    version: "8"
`;
    const NOTE = {
      kind: 'no-password',
      configName: 'web',
      variable: 'REDIS_PASSWORD',
      message:
        "web.env.REDIS_PASSWORD links to redis.password: a redis on Memorystore has no password, so REDIS_PASSWORD is left unset. Only this Environment's private network reaches it, over TLS, so any Service in this Environment can connect to it, linked to it or not.",
    };

    it('notes the variable is left unset, and that any Service in the Environment can connect, for one the plan creates', () => {
      expect(
        planned(webAndRedis).notes.filter(
          (note) => note.kind === 'no-password',
        ),
      ).toEqual([NOTE]);
    });

    it('notes the same for one already on Memorystore', () => {
      expect(
        planned(webAndRedis, [
          onMemorystore({ cpu: 0.5, memoryMb: 1024 }),
        ]).notes.filter((note) => note.kind === 'no-password'),
      ).toEqual([NOTE]);
    });
  });
});

/**
 * ADR-0044 rules 3, 6 and 10: a redis on Memorystore plans its
 * `native.gcp` as lines against the block its last Apply laid, a native
 * line moving the instance; its `engine_configs` key by key; and its
 * high availability is the console's, which native wins over and hands
 * back where it is when taken out.
 */
describe('planEnvironment, a redis on Memorystore with native.gcp', () => {
  const CACHE = '"google_memorystore_instance.cache"';
  const native = (lines: string) =>
    `    version: "8"\n    native:\n      gcp:\n        ${CACHE}:\n${lines}`;
  const POLICY =
    '          engine_configs:\n            maxmemory-policy: allkeys-lru\n';

  it('plans maxmemory-policy as a native line over Cloudgate’s noeviction, the move carrying the block', () => {
    const { step } = changed(native(POLICY), onMemorystore(null));

    expect(step.fields).toEqual([
      {
        field: `native.gcp.${CACHE}.engine_configs.maxmemory-policy`,
        from: 'noeviction',
        to: 'allkeys-lru',
        native: true,
        fromDefault: true,
      },
    ]);
    expect(step.memorystore).toEqual({
      nodeType: null,
      version: null,
      highAvailability: null,
      lines: [],
      native: {
        'google_memorystore_instance.cache': {
          engine_configs: { 'maxmemory-policy': 'allkeys-lru' },
        },
      },
    });
    expect(step.cloudRead).toEqual({ status: 'reading' });
  });

  it('creates one with it, its read laying the block', () => {
    const step = created(native(POLICY));

    expect(step.memorystore?.native).toEqual({
      'google_memorystore_instance.cache': {
        engine_configs: { 'maxmemory-policy': 'allkeys-lru' },
      },
    });
  });

  const REPLICAS = `native.gcp.${CACHE}.replica_count`;

  it('sets replica_count over the console’s high availability, native winning', () => {
    const { step } = changed(
      native('          replica_count: 1\n'),
      onMemorystore(null),
    );

    expect(step.fields).toEqual([
      { field: REPLICAS, from: 0, to: 1, native: true, fromConsole: true },
    ]);
    // The console's own move is not planned beside it: native's is the one.
    expect(step.memorystore?.highAvailability).toBeNull();
  });

  it('creates one with the replica native sets: two nodes', () => {
    const step = created(native('          replica_count: 1\n'));

    expect(step.memorystore?.nodes).toBe(2);
  });

  it('hands replica_count taken out back to the console where it is, never to one node', () => {
    // Its Apply wrote high availability on beside the block.
    const { step } = changed('    version: "8"\n', {
      ...onMemorystore(null, '8', true),
      nativeGcp: { 'google_memorystore_instance.cache': { replica_count: 1 } },
    });

    expect(step.fields).toEqual([
      { field: REPLICAS, from: 1, to: 1, native: true, toConsole: true },
    ]);
    expect(step.memorystore?.native).toBeNull();
  });
});

describe('planEnvironment, an exact node type on Memorystore: native.gcp node_type wins over size', () => {
  const CACHE = '"google_memorystore_instance.cache"';
  const NODE_TYPE = `native.gcp.${CACHE}.node_type`;
  const withType = (size: string, nodeType = 'HIGHMEM_XLARGE') =>
    `    version: "8"\n${size}    native:\n      gcp:\n        ${CACHE}:\n          node_type: ${nodeType}\n`;
  const BLOCK = {
    'google_memorystore_instance.cache': { node_type: 'HIGHMEM_XLARGE' },
  };
  /** `saved` applied with the native node type, which it runs on since. */
  const onNative = (
    saved: Extract<SavedService, { serviceType: 'redis' }>,
  ): SavedService => ({
    ...saved,
    memorystore: { ...saved.memorystore!, nodeType: 'HIGHMEM_XLARGE' },
    nativeGcp: BLOCK,
  });
  const MEDIUM = { cpu: 1, memoryMb: 2048 };
  const nativeLines = (step: { fields: readonly unknown[] }) =>
    step.fields.filter((field) => (field as { native?: true }).native);

  it('creates it on the native node type, its size line naming the size it gives way to', () => {
    const step = created(withType('    size: medium\n'));

    expect(step.memorystore?.size).toEqual({
      name: 'medium',
      nodeType: 'HIGHMEM_XLARGE',
      writableMemory: '46.4 GB',
      smallest: false,
      native: true,
    });
    expect(step.memorystore?.lines[0]).toBe(
      'redis medium → highmem-xlarge (46.4 GB, 1 node), set by native',
    );
    expect(nativeLines(step)).toEqual([
      {
        field: NODE_TYPE,
        from: null,
        to: 'HIGHMEM_XLARGE',
        native: true,
        fromSize: true,
      },
    ]);
  });

  it('names a node type Cloudgate never chooses alone', () => {
    expect(
      created(withType('    size: medium\n', 'SHARED_CORE_NANO')).memorystore
        ?.lines[0],
    ).toBe('redis medium → shared-core-nano (1 node), set by native');
  });

  it('moves a made one to the native node type, marked native, with the resize warning', () => {
    const { step } = changed(
      withType('    size: medium\n'),
      onMemorystore(MEDIUM),
    );

    expect(nativeLines(step)).toEqual([
      {
        field: NODE_TYPE,
        from: 'CUSTOM_MICRO',
        to: 'HIGHMEM_XLARGE',
        native: true,
        fromSize: true,
      },
    ]);
    expect(step.memorystore).toMatchObject({
      nodeType: {
        from: 'CUSTOM_MICRO',
        to: 'HIGHMEM_XLARGE',
        writableMemory: '46.4 GB',
        sizeName: 'medium',
        native: true,
      },
      lines: [
        'redis medium → highmem-xlarge (46.4 GB, 1 node), set by native, from custom-micro',
        'redis: may drop connections briefly while it resizes',
      ],
      native: BLOCK,
    });
  });

  it('plans nothing once the native node type is applied', () => {
    expect(
      planned(entry(withType('    size: medium\n')), [
        onNative(onMemorystore(MEDIUM)),
      ]).steps,
    ).toEqual([]);
  });

  it("taken out with a size, falls back to the size's node type", () => {
    const { step } = changed(
      '    version: "8"\n    size: medium\n',
      onNative(onMemorystore(MEDIUM)),
    );

    expect(nativeLines(step)).toEqual([
      {
        field: NODE_TYPE,
        from: 'HIGHMEM_XLARGE',
        to: 'CUSTOM_MICRO',
        native: true,
        toSize: true,
      },
    ]);
    expect(step.memorystore).toMatchObject({
      nodeType: { from: 'HIGHMEM_XLARGE', to: 'CUSTOM_MICRO' },
      lines: [
        'redis medium → custom-micro (2 GB, 1 node), from highmem-xlarge',
        'redis: may drop connections briefly while it resizes',
      ],
      native: null,
    });
  });

  it('taken out with no size, stays where it is and is handed back to the console, never the smallest', () => {
    const { step } = changed(
      '    version: "8"\n',
      onNative(onMemorystore(null)),
    );

    expect(nativeLines(step)).toEqual([
      {
        field: NODE_TYPE,
        from: 'HIGHMEM_XLARGE',
        to: 'HIGHMEM_XLARGE',
        native: true,
        toConsole: true,
      },
    ]);
    expect(step.memorystore).toMatchObject({ nodeType: null, native: null });
  });
});
