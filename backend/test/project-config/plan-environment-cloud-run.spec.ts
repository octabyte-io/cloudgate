import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanOutcome,
  PlanStep,
  ProjectConfig,
  SavedService,
} from '../../src/project-config';

const GOOGLE: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-1',
  region: 'europe-west1',
};

function config(text: string): ProjectConfig {
  const result = parseProjectConfig(text);
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.config;
}

function plan(text: string, saved: SavedService[] = []): PlanOutcome {
  return planEnvironment({
    config: config(text),
    saved,
    deployTarget: GOOGLE,
    cloud: 'gcp',
    context: { previous: null },
  });
}

/** The `web` entry `api` with this `size:` line, or none. */
const web = (size?: string) =>
  `version: 1\nservices:\n  api:\n    kind: web\n${size ? `    size: ${size}\n` : ''}    source: { image: nginx }\n`;

type Create = Extract<PlanStep, { action: 'create' }>;
type Change = Extract<PlanStep, { action: 'change' }>;

function createdApi(size?: string): Create {
  const outcome = plan(web(size));
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.refusals));
  const step = outcome.steps.find(
    (one): one is Create => one.action === 'create',
  );
  if (!step) throw new Error('no create');
  return step;
}

const ON_CREATE = [
  'CPU only during requests',
  '0–10 copies: scales to zero, so the first request after idle waits for a start',
];

/** `api` on Cloud Run already, its caps the live pair. */
function onCloudRun(cpuLimit: string, memoryLimit: string): SavedService {
  return {
    serviceType: 'application',
    serviceId: 'app-api',
    name: 'App api',
    configName: 'api',
    cloud: {
      cloudAccountId: 'ca-1',
      region: 'europe-west1',
      linkedRegistries: [],
    },
    settings: {
      configKind: 'web',
      description: null,
      cpuLimit,
      memoryLimit,
      command: null,
      args: null,
      port: 3000,
      cronSchedule: null,
      cronTimezone: null,
      cronTimeoutSeconds: null,
      sourceType: 'docker',
      owner: null,
      repository: null,
      buildPath: '/',
      gitlabOwner: null,
      gitlabRepository: null,
      gitlabPathNamespace: null,
      gitlabBuildPath: '/',
      giteaOwner: null,
      giteaRepository: null,
      giteaBuildPath: '/',
      bitbucketOwner: null,
      bitbucketRepository: null,
      bitbucketBuildPath: '/',
      customGitUrl: null,
      customGitBuildPath: null,
      dockerImage: 'nginx',
      buildType: 'nixpacks',
      railpackVersion: '0.15.4',
      herokuVersion: '24',
      dockerfile: 'Dockerfile',
      dockerContextPath: null,
      dockerBuildStage: null,
      publishDirectory: null,
      isStaticSpa: null,
      createEnvFile: true,
      enableSubmodules: false,
      watchPaths: null,
    },
    variables: { env: [], buildArgs: [], buildSecrets: [] },
  };
}

/**
 * Spec "Sizes" (S3): on a Google Deploy target a `web`'s size
 * lands on a Cloud Run CPU and memory pair, never under 1 CPU, always
 * rounded up, and the plan says so in Cloud Run's own words.
 */
describe('planEnvironment, a web on a Google Deploy target', () => {
  it.each([
    ['xsmall', '1 CPU / 512 MB', '0.25 CPU'],
    ['small', '1 CPU / 1 GB', '0.5 CPU'],
    ['medium', '1 CPU / 2 GB', undefined],
    ['large', '2 CPU / 4 GB', undefined],
    ['xlarge', '4 CPU / 8 GB', undefined],
    ['2xlarge', '8 CPU / 16 GB', undefined],
  ])('runs size %s at Cloud Run %s', (size, wording, roundedUpFrom) => {
    expect(createdApi(size).cloud?.size).toEqual({
      name: size,
      pair: {
        runsOn: 'Cloud Run',
        wording,
        ...(roundedUpFrom ? { roundedUpFrom } : {}),
        notes: ON_CREATE,
      },
    });
  });

  it.each([
    // CPU raised to the next count Cloud Run allows.
    ['{ cpu: 1.5, memory: 3 GB }', '2 CPU / 3 GB', '1.5 CPU'],
    // Memory raised to 4 CPU's minimum.
    ['{ cpu: 4, memory: 1 GB }', '4 CPU / 2 GB', '1 GB'],
    // CPU raised until its count holds the memory asked for.
    ['{ cpu: 1, memory: 8 GB }', '2 CPU / 8 GB', '1 CPU'],
    // Both raised.
    ['{ cpu: 5, memory: 2 GB }', '6 CPU / 4 GB', '5 CPU / 2 GB'],
    ['{ cpu: 8, memory: 32 GB }', '8 CPU / 32 GB', undefined],
  ])('rounds the custom size %s up to %s', (size, wording, roundedUpFrom) => {
    expect(createdApi(size).cloud?.size.pair).toEqual({
      runsOn: 'Cloud Run',
      wording,
      ...(roundedUpFrom ? { roundedUpFrom } : {}),
      notes: ON_CREATE,
    });
  });

  it.each([['{ cpu: 16, memory: 8 GB }'], ['{ cpu: 2, memory: 64 GB }']])(
    "refuses %s, above Cloud Run's largest, naming the entry and the limit",
    (size) => {
      const outcome = plan(web(size));

      expect(outcome).toEqual({
        ok: false,
        refusals: [
          {
            at: 'api.size',
            message: expect.stringMatching(
              /^api: size .+ is above Cloud Run's largest, 8 CPU \/ 32 GB$/,
            ) as string,
          },
        ],
      });
    },
  );

  it("creates a web with no size at Cloud Run's own 1 CPU / 512 MB", () => {
    expect(createdApi().cloud?.size).toEqual({
      name: null,
      pair: {
        runsOn: 'Cloud Run',
        wording: '1 CPU / 512 MB',
        notes: ON_CREATE,
      },
    });
  });

  it('makes the Environment network first, as its own step', () => {
    const outcome = plan(web('small'));

    expect(outcome.ok && outcome.steps.map((step) => step.action)).toEqual([
      'network-create',
      'create',
    ]);
  });

  describe('a change to a web already on Cloud Run', () => {
    const changed = (outcome: PlanOutcome): Change => {
      if (!outcome.ok) throw new Error(JSON.stringify(outcome.refusals));
      const step = outcome.steps.find(
        (one): one is Change => one.action === 'change',
      );
      if (!step) throw new Error('no change');
      return step;
    };

    it('is still a change when the new size rounds to the same pair, saying so', () => {
      // Running at 2 CPU / 3 GB; `{1.5, 3GB}` rounds to the same pair.
      const step = changed(
        plan(web('{ cpu: 1.5, memory: 3 GB }'), [
          onCloudRun('2000000000', String(3 * 1024 ** 3)),
        ]),
      );

      expect(step.fields).toContainEqual(
        expect.objectContaining({ field: 'size' }),
      );
      expect(step.cloud?.size.pair).toEqual({
        runsOn: 'Cloud Run',
        wording: '2 CPU / 3 GB',
        roundedUpFrom: '1.5 CPU',
        notes: ['same on Cloud Run: 2 CPU / 3 GB'],
      });
    });

    it('names no billing or copy range when they do not change', () => {
      const step = changed(
        plan(web('large'), [onCloudRun('1000000000', String(2 * 1024 ** 3))]),
      );

      expect(step.cloud?.size.pair).toEqual({
        runsOn: 'Cloud Run',
        wording: '2 CPU / 4 GB',
      });
    });
  });
});

/**
 * Spec "`HEALTHCHECK` on Google Cloud" (stories 67–68): a
 * Cloud Run probe is HTTP, TCP or gRPC only, so no always-running Service
 * there runs its image's `HEALTHCHECK`, and the plan says so once per
 * Service instead of dropping it silently.
 */
describe("planEnvironment, a live image's HEALTHCHECK on Google Cloud", () => {
  const medium = web('medium');
  /** `api` on Cloud Run at medium's pair, so a plan of it changes nothing. */
  const live = (): SavedService => {
    const found = onCloudRun('1000000000', String(2 * 1024 ** 3));
    if (!found.cloud) throw new Error('not in a Cloud account');
    return { ...found, cloud: { ...found.cloud, cloud: 'gcp' } };
  };
  const healthNotes = (outcome: PlanOutcome) => {
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.refusals));
    return outcome.notes.filter((note) => note.kind === 'healthcheck-not-run');
  };

  it('notes once that Google Cloud cannot run it, for a web whose live image has one', () => {
    const outcome = planEnvironment({
      config: config(medium),
      saved: [live()],
      deployTarget: GOOGLE,
      cloud: 'gcp',
      context: { previous: null },
      imageHealthChecks: ['app-api'],
    });

    expect(healthNotes(outcome)).toEqual([
      {
        kind: 'healthcheck-not-run',
        configName: 'api',
        message:
          "api: its image's HEALTHCHECK is not run on Google Cloud, whose health checks are HTTP, TCP or gRPC only and cannot run a command",
      },
    ]);
  });

  it('notes nothing for an image with none, HEALTHCHECK NONE included', () => {
    expect(healthNotes(plan(medium, [live()]))).toEqual([]);
  });

  it('notes nothing for a web the plan creates, which has no live image yet', () => {
    const outcome = planEnvironment({
      config: config(medium),
      saved: [],
      deployTarget: GOOGLE,
      cloud: 'gcp',
      context: { previous: null },
      imageHealthChecks: ['app-api'],
    });

    expect(healthNotes(outcome)).toEqual([]);
  });

  it('notes nothing on AWS, where the task runs it', () => {
    const outcome = planEnvironment({
      config: config(medium),
      saved: [onCloudRun('1024', '2048')],
      deployTarget: GOOGLE,
      cloud: 'aws',
      context: { previous: null },
      imageHealthChecks: ['app-api'],
    });

    expect(healthNotes(outcome)).toEqual([]);
  });

  it('notes once that Google Cloud cannot run it for a worker too, which runs until it is stopped', () => {
    const found = live();
    if (found.serviceType !== 'application') throw new Error('not an app');
    const outcome = planEnvironment({
      config: config(
        'version: 1\nservices:\n  api:\n    kind: worker\n    command: node worker.js\n    size: medium\n    source: { image: nginx }\n',
      ),
      saved: [
        {
          ...found,
          settings: {
            ...found.settings,
            configKind: 'worker',
            command: 'node worker.js',
          },
        },
      ],
      deployTarget: GOOGLE,
      cloud: 'gcp',
      context: { previous: null },
      imageHealthChecks: ['app-api'],
    });

    expect(healthNotes(outcome)).toEqual([
      {
        kind: 'healthcheck-not-run',
        configName: 'api',
        message:
          "api: its image's HEALTHCHECK is not run on Google Cloud, whose health checks are HTTP, TCP or gRPC only and cannot run a command",
      },
    ]);
  });
});

/** The `worker` entry `jobs` with this `size:` line, or none. */
const worker = (size?: string) =>
  `version: 1\nservices:\n  jobs:\n    kind: worker\n    command: node worker.js\n${size ? `    size: ${size}\n` : ''}    source: { image: acme/jobs }\n`;

/** What a worker pool's create says of how it runs. */
const ON_WORKER_CREATE = [
  'a worker pool: CPU always on, billed while its instances run',
  'its replicas are its instance count, with no automatic scaling',
];

/** What a size rounded up for a worker pool says beside its wording. */
const WORKER_ROUNDED =
  'a worker pool takes no less than 1 CPU / 512 MB, so the size was rounded up';

/**
 * A Worker on Google Cloud (spec "Worker on Google Cloud"): a
 * Cloud Run worker pool, planned with no load-balancer piece, its size on a
 * pair a worker pool takes, rounded up with a note and never refused.
 */
describe('planEnvironment, a worker on a Google Deploy target', () => {
  function createdJobs(size?: string): Create {
    const outcome = plan(worker(size));
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.refusals));
    const step = outcome.steps.find(
      (one): one is Create => one.action === 'create',
    );
    if (!step) throw new Error('no create');
    return step;
  }

  it('is no longer refused there, and makes the whole Environment network first', () => {
    const outcome = plan(worker());

    expect(outcome.ok && outcome.steps.map((step) => step.action)).toEqual([
      'network-create',
      'create',
    ]);
  });

  it("is created from its command with no port, at a worker pool's 1 CPU / 512 MB when it names no size", () => {
    const step = createdJobs();

    expect(step.kind).toBe('worker');
    expect(step.cloud?.service).toEqual({
      port: null,
      command: 'node worker.js',
      args: [],
      size: null,
    });
    expect(step.cloud?.size).toEqual({
      name: null,
      pair: {
        runsOn: 'Cloud Run',
        wording: '1 CPU / 512 MB',
        notes: ON_WORKER_CREATE,
      },
    });
  });

  it.each([
    ['xsmall', '1 CPU / 512 MB', '0.25 CPU'],
    ['small', '1 CPU / 1 GB', '0.5 CPU'],
  ])(
    'rounds size %s up to %s, saying so, rather than refusing it',
    (size, wording, roundedUpFrom) => {
      expect(createdJobs(size).cloud?.size.pair).toEqual({
        runsOn: 'Cloud Run',
        wording,
        roundedUpFrom,
        notes: [WORKER_ROUNDED, ...ON_WORKER_CREATE],
      });
    },
  );

  it('keeps a size a worker pool takes as it is, with no rounding note', () => {
    expect(createdJobs('large').cloud?.size.pair).toEqual({
      runsOn: 'Cloud Run',
      wording: '2 CPU / 4 GB',
      notes: ON_WORKER_CREATE,
    });
  });

  it('switches a web on Cloud Run to a worker as a destroy and a create, never in place', () => {
    const outcome = plan(
      'version: 1\nservices:\n  api:\n    kind: worker\n    command: node worker.js\n    source: { image: nginx }\n',
      [onCloudRun('1000000000', String(512 * 1024 ** 2))],
    );
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.refusals));

    expect(
      outcome.steps.flatMap((step) =>
        'configName' in step ? [`${step.action} ${step.configName}`] : [],
      ),
    ).toEqual(['destroy api', 'create api']);
    const created = outcome.steps.find(
      (one): one is Create => one.action === 'create',
    );
    expect(created?.kind).toBe('worker');
    expect(created?.cloud?.service.port).toBeNull();
  });

  it('says nothing of a web: no Domain note, no request-only CPU or copy range', () => {
    const outcome = plan(worker());
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.refusals));

    expect(JSON.stringify(outcome)).not.toMatch(
      /No Domain yet|CPU only during requests|copies: scales to zero/,
    );
  });
});

/** The `web-private` entry `inside`, on port 4000. */
const INSIDE =
  'version: 1\nservices:\n  inside:\n    kind: web-private\n    port: 4000\n    source: { image: acme/inside:1 }\n';

/** `name` on Cloud Run already, as `configKind`, on port 4000. */
function onCloudRunAs(name: string, configKind: string): SavedService {
  const found = onCloudRun('1000000000', String(512 * 1024 ** 2));
  if (found.serviceType !== 'application') throw new Error('not an app');
  return {
    ...found,
    serviceId: `app-${name}`,
    configName: name,
    settings: {
      ...found.settings,
      configKind: configKind as typeof found.settings.configKind,
      port: 4000,
      command: configKind === 'worker' ? 'node worker.js' : null,
    },
  };
}

/**
 * A Private web service on Google Cloud (spec "Private web
 * service on Google Cloud"): a Cloud Run service with internal-only
 * ingress, whose first create in an Environment network adds the
 * network's private `run.app` zone on the network step, which then stays
 * until the network goes, as the AWS namespace does.
 */
describe('planEnvironment, a web-private on a Google Deploy target', () => {
  type Network = NonNullable<Parameters<typeof planEnvironment>[0]['networks']>;
  const made = (privateLinks?: ('run-app-zone' | 'cloud-sql')[]): Network => [
    {
      cloudAccountId: 'ca-1',
      region: 'europe-west1',
      environmentNetworkId: 'net-1',
      ...(privateLinks ? { privateLinks } : {}),
    },
  ];
  function planned(
    text: string,
    saved: SavedService[] = [],
    networks?: Network,
    previous: string | null = null,
  ): readonly PlanStep[] {
    const outcome = planEnvironment({
      config: config(text),
      saved,
      deployTarget: GOOGLE,
      cloud: 'gcp',
      context: { previous: previous === null ? null : config(previous) },
      ...(networks ? { networks } : {}),
    });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.refusals));
    return outcome.steps;
  }
  const actions = (steps: readonly PlanStep[]) =>
    steps.map((step) =>
      'configName' in step
        ? `${step.action} ${step.configName}`
        : `${step.action} ${step.region}`,
    );

  it('is no longer refused there, and makes the network with its run.app zone first', () => {
    const steps = planned(INSIDE);

    expect(steps[0]).toEqual({
      action: 'network-create',
      cloudAccountId: 'ca-1',
      region: 'europe-west1',
      privateLinks: ['run-app-zone'],
      cloudRead: { status: 'reading' },
    });
    expect(steps[1]).toMatchObject({
      action: 'create',
      configName: 'inside',
      kind: 'web-private',
      cloud: { service: { port: 4000 } },
    });
  });

  it('adds the zone to a made network that has none, as its own network step', () => {
    const steps = planned(INSIDE, [], made());

    expect(steps[0]).toEqual({
      action: 'network-change',
      environmentNetworkId: 'net-1',
      cloudAccountId: 'ca-1',
      region: 'europe-west1',
      privateLinks: ['run-app-zone'],
      cloudRead: { status: 'reading' },
    });
    expect(actions(steps)).toEqual([
      'network-change europe-west1',
      'create inside',
    ]);
  });

  it("adds it beside a database's private link the network holds, asking only for the zone", () => {
    const steps = planned(INSIDE, [], made(['cloud-sql']));

    expect(steps[0]).toMatchObject({
      action: 'network-change',
      privateLinks: ['run-app-zone'],
    });
  });

  it('does not add it again for a second web-private', () => {
    const steps = planned(
      `${INSIDE}  other:\n    kind: web-private\n    port: 5000\n    source: { image: acme/other:1 }\n`,
      [onCloudRunAs('inside', 'web-private')],
      made(['run-app-zone']),
    );

    expect(actions(steps)).toContain('create other');
    expect(actions(steps).filter((one) => one.startsWith('network'))).toEqual(
      [],
    );
  });

  it('keeps it when the last web-private goes: only the Service is destroyed', () => {
    const steps = planned(
      'version: 1\nservices:\n  api:\n    kind: web\n    source: { image: nginx }\n',
      [onCloudRunAs('inside', 'web-private')],
      made(['run-app-zone']),
      INSIDE,
    );

    expect(actions(steps)).toContain('destroy inside');
    expect(actions(steps).filter((one) => one.startsWith('network'))).toEqual(
      [],
    );
  });

  it('adds nothing to the network for a web or a worker', () => {
    expect(actions(planned(web(), [], made()))).toEqual(['create api']);
    expect(actions(planned(worker(), [], made()))).toEqual(['create jobs']);
  });

  it('says nothing of a Domain: it takes none', () => {
    const outcome = plan(INSIDE);

    expect(JSON.stringify(outcome)).not.toMatch(/No Domain yet/);
  });

  it('destroys and creates when a web or a worker there becomes a web-private, and back', () => {
    for (const from of ['web', 'worker']) {
      const steps = planned(
        INSIDE,
        [onCloudRunAs('inside', from)],
        made(['run-app-zone']),
      );
      expect(actions(steps)).toEqual(['destroy inside', 'create inside']);
      expect(steps[1]).toMatchObject({ kind: 'web-private' });
    }
    for (const to of [
      'version: 1\nservices:\n  inside:\n    kind: web\n    port: 4000\n    source: { image: acme/inside:1 }\n',
      'version: 1\nservices:\n  inside:\n    kind: worker\n    command: node worker.js\n    source: { image: acme/inside:1 }\n',
    ]) {
      const steps = planned(
        to,
        [onCloudRunAs('inside', 'web-private')],
        made(['run-app-zone']),
      );
      expect(actions(steps)).toEqual(['destroy inside', 'create inside']);
    }
  });
});

/** The `cron` entry `report`, weekdays at 03:00, held to 30 minutes. */
const REPORT =
  'version: 1\nservices:\n  report:\n    kind: cron\n    command: node dist/report.js\n    schedule: "0 3 * * MON-FRI"\n    timeout: 30m\n    source: { image: acme/reports:1 }\n';

/** `report` on Cloud Run already, as a Cron service's job. */
function cronOnCloudRun(): SavedService {
  const found = onCloudRunAs('report', 'cron');
  if (found.serviceType !== 'application') throw new Error('not an app');
  return {
    ...found,
    settings: {
      ...found.settings,
      command: 'node dist/report.js',
      dockerImage: 'acme/reports:1',
      cronSchedule: '0 3 * * MON-FRI',
      cronTimezone: 'UTC',
      cronTimeoutSeconds: 1800,
    },
  };
}

/**
 * A Cron service on Google Cloud (spec "Cron service on Google
 * Cloud", stories 32, 52–54): a Cloud Run job each run is one execution
 * of, its timetable Cloudgate's own setting with no Google line.
 */
describe('planEnvironment, a cron on a Google Deploy target', () => {
  function steps(text: string, saved: SavedService[] = []) {
    const outcome = plan(text, saved);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.refusals));
    return outcome.steps;
  }

  it('is no longer refused there, and is created as a job from its command with no port, reading Google', () => {
    const [network, report] = steps(REPORT);

    expect(network.action).toBe('network-create');
    expect(report).toMatchObject({
      action: 'create',
      kind: 'cron',
      cloud: {
        service: {
          port: null,
          command: 'node dist/report.js',
          args: [],
          size: null,
        },
        size: {
          pair: {
            runsOn: 'Cloud Run',
            wording: '1 CPU / 512 MB',
            notes: [
              'a job: billed only while a run executes',
              "each run is one execution Cloudgate's timetable starts: one task, no retries",
            ],
          },
        },
      },
      cloudRead: { status: 'reading' },
    });
  });

  it('says nothing of a web, a worker pool or a HEALTHCHECK', () => {
    expect(JSON.stringify(steps(REPORT))).not.toMatch(
      /No Domain yet|CPU only during requests|copies: scales to zero|worker pool|HEALTHCHECK/,
    );
  });

  it.each([
    ['schedule', 'schedule: "0 3 * * MON-FRI"', 'schedule: "0 4 * * *"'],
    ['timezone', 'timeout: 30m', 'timeout: 30m\n    timezone: Europe/Berlin'],
    ['timeout', 'timeout: 30m', 'timeout: 45m'],
  ])(
    'plans a changed %s alone as a Cloudgate setting, reading nothing of Google',
    (field, from, to) => {
      const [step] = steps(REPORT.replace(from, to), [cronOnCloudRun()]);

      expect(step).toMatchObject({
        action: 'change',
        configName: 'report',
        fields: [expect.objectContaining({ field })],
      });
      expect(step).not.toHaveProperty('cloudRead');
      expect(step).not.toHaveProperty('cloud');
    },
  );

  it('reads Google for a changed command, which is a line on the job', () => {
    const [step] = steps(
      REPORT.replace('node dist/report.js', 'node dist/report-v2.js'),
      [cronOnCloudRun()],
    );

    expect(step).toMatchObject({
      action: 'change',
      fields: [expect.objectContaining({ field: 'command' })],
      cloudRead: { status: 'reading' },
    });
  });
});
