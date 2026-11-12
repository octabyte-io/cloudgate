import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanInput,
  PlanNote,
  PlanOutcome,
  PlanStep,
  SavedService,
} from '../../src/project-config';
import type { NativeGcpBlock } from '../../src/native/gcp-native';

/**
 * ADR-0044 rule 6 (spec stories 10, 12, 13, 28): `native.gcp` on a
 * `web` on Cloud Run as native lines of its step, in the file's spelling,
 * against the block its last Apply laid; a key taken out shows what it
 * returns to; closing its `run.app` address is noted, and warned of with
 * no Domain. Off Google Cloud the block is checked only.
 */

const GOOGLE: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-1',
  region: 'europe-west1',
};

type Entry = Record<string, unknown>;

function plan(
  services: Record<string, Entry>,
  more: Partial<PlanInput> = {},
): PlanOutcome {
  const parsed = parseProjectConfig(JSON.stringify({ version: 1, services }));
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal.message}`);
  return planEnvironment({
    config: parsed.config,
    saved: [],
    deployTarget: GOOGLE,
    cloud: 'gcp',
    context: { previous: null },
    networks: [{ cloudAccountId: 'ca-1', region: 'europe-west1' }],
    ...more,
  });
}

function stepOf(outcome: PlanOutcome): PlanStep | undefined {
  if (!outcome.ok) {
    throw new Error(outcome.refusals.map((r) => r.message).join('; '));
  }
  return outcome.steps.find(
    (step) =>
      'configName' in step &&
      step.configName === 'api' &&
      (step.action === 'create' || step.action === 'change'),
  );
}

function nativeFields(step: PlanStep | undefined) {
  if (!step || (step.action !== 'create' && step.action !== 'change')) {
    throw new Error('no create or change');
  }
  return step.fields.filter((field) => 'native' in field && field.native);
}

function runAppNotes(outcome: PlanOutcome): PlanNote[] {
  if (!outcome.ok) throw new Error('refused');
  return outcome.notes.filter((note) => note.kind.startsWith('run-app'));
}

/** `api` on Cloud Run already, a web with no size and the image nginx. */
function onCloudRun(
  nativeGcp?: NativeGcpBlock,
  hasDomain = true,
): SavedService {
  return {
    serviceType: 'application',
    serviceId: 'app-api',
    name: 'App api',
    configName: 'api',
    cloud: {
      cloudAccountId: 'ca-1',
      region: 'europe-west1',
      cloud: 'gcp',
      linkedRegistries: [],
    },
    ...(nativeGcp ? { nativeGcp } : {}),
    hasDomain,
    settings: {
      configKind: 'web',
      description: null,
      cpuLimit: null,
      memoryLimit: null,
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

const web = (gcp?: NativeGcpBlock): Entry => ({
  kind: 'web',
  port: 3000,
  source: { image: 'nginx' },
  ...(gcp ? { native: { gcp } } : {}),
});

const RUN = 'google_cloud_run_v2_service.service';
const AT = `native.gcp.${JSON.stringify(RUN)}`;
const CONCURRENCY: NativeGcpBlock = {
  [RUN]: { template: { max_instance_request_concurrency: 20 } },
};
const CLOSED: NativeGcpBlock = {
  [RUN]: { ingress: 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER' },
};
const CLOSES =
  'api: run.app address closes: only Domains and this Environment reach it';

describe('planEnvironment native.gcp on a web on Cloud Run', () => {
  it('plans max_instance_request_concurrency as a native line, and its read lays it', () => {
    const step = stepOf(
      plan({ api: web(CONCURRENCY) }, { saved: [onCloudRun()] }),
    );
    expect(nativeFields(step)).toEqual([
      {
        field: `${AT}.template.max_instance_request_concurrency`,
        from: null,
        to: 20,
        native: true,
        fromDefault: true,
      },
    ]);
    expect(step?.action === 'change' && step.cloud?.nativeGcp).toEqual(
      CONCURRENCY,
    );
    expect(step?.action === 'change' && step.cloudRead).toEqual({
      status: 'reading',
    });
  });

  it('plans no change once the applied block is the entry’s', () => {
    expect(
      stepOf(
        plan({ api: web(CONCURRENCY) }, { saved: [onCloudRun(CONCURRENCY)] }),
      ),
    ).toBeUndefined();
  });

  it('plans the container’s fields one line each, a field Cloudgate writes from its value', () => {
    const step = stepOf(
      plan(
        {
          api: web({
            [RUN]: {
              template: {
                containers: {
                  liveness_probe: { http_get: { path: '/healthz' } },
                  resources: { cpu_idle: false, startup_cpu_boost: true },
                },
              },
            },
          }),
        },
        { saved: [onCloudRun()] },
      ),
    );
    const container = `${AT}.template.containers`;
    expect(nativeFields(step)).toEqual([
      {
        field: `${container}.liveness_probe.http_get.path`,
        from: null,
        to: '/healthz',
        native: true,
        fromDefault: true,
      },
      {
        field: `${container}.resources.cpu_idle`,
        from: true,
        to: false,
        native: true,
        fromDefault: true,
      },
      {
        field: `${container}.resources.startup_cpu_boost`,
        from: null,
        to: true,
        native: true,
        fromDefault: true,
      },
    ]);
  });

  it('plans a removed key back to Cloudgate’s default, showing what it returns to', () => {
    const stored: NativeGcpBlock = {
      [RUN]: {
        template: { containers: { resources: { cpu_idle: false } } },
      },
      'google_compute_backend_service.service': { timeout_sec: 60 },
    };
    const step = stepOf(plan({ api: web() }, { saved: [onCloudRun(stored)] }));
    expect(nativeFields(step)).toEqual([
      {
        field: `${AT}.template.containers.resources.cpu_idle`,
        from: false,
        to: true,
        native: true,
        toDefault: true,
      },
      {
        field:
          'native.gcp."google_compute_backend_service.service".timeout_sec',
        from: 60,
        to: null,
        native: true,
        toDefault: true,
      },
    ]);
    expect(step?.action === 'change' && step.cloud?.nativeGcp).toBeUndefined();
  });

  it('plans a create’s native values as lines, and its read lays them', () => {
    const step = stepOf(plan({ api: web(CONCURRENCY) }));
    expect(step?.action).toBe('create');
    expect(nativeFields(step).map((field) => field.field)).toEqual([
      `${AT}.template.max_instance_request_concurrency`,
    ]);
    expect(step?.action === 'create' && step.cloud?.nativeGcp).toEqual(
      CONCURRENCY,
    );
  });

  it('plans nothing of native.gcp on AWS or a Server, where it is checked only', () => {
    for (const outcome of [
      plan({ api: web(CONCURRENCY) }, { cloud: 'aws' }),
      plan(
        { api: web(CONCURRENCY) },
        { deployTarget: { kind: 'platform-host' } },
      ),
    ]) {
      const step = stepOf(outcome);
      expect(nativeFields(step)).toEqual([]);
      expect(
        step?.action === 'create' && step.cloud?.nativeGcp,
      ).toBeUndefined();
    }
  });

  describe('closing the run.app address', () => {
    it('plans the ingress as a native line and notes that only Domains and this Environment reach it', () => {
      const outcome = plan({ api: web(CLOSED) }, { saved: [onCloudRun()] });
      expect(nativeFields(stepOf(outcome))).toEqual([
        {
          field: `${AT}.ingress`,
          from: 'INGRESS_TRAFFIC_ALL',
          to: 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER',
          native: true,
          fromDefault: true,
        },
      ]);
      expect(runAppNotes(outcome)).toEqual([
        { kind: 'run-app-closes', configName: 'api', message: CLOSES },
      ]);
    });

    it('warns when the Service has no Domain', () => {
      const outcome = plan(
        { api: web(CLOSED) },
        { saved: [onCloudRun(undefined, false)] },
      );
      expect(runAppNotes(outcome).map((note) => note.kind)).toEqual([
        'run-app-closes',
        'run-app-closes-no-domain',
      ]);
      expect(runAppNotes(outcome)[1].message).toMatch(
        /^api: has no Domain, so once its run.app address closes nothing outside this Environment reaches it/,
      );
    });

    it('warns on a create, which has no Domain yet', () => {
      expect(
        runAppNotes(plan({ api: web(CLOSED) })).map((note) => note.kind),
      ).toEqual(['run-app-closes', 'run-app-closes-no-domain']);
    });

    it('notes nothing once the address is closed, nor while it stays open', () => {
      expect(
        runAppNotes(
          plan({ api: web(CLOSED) }, { saved: [onCloudRun(CLOSED)] }),
        ),
      ).toEqual([]);
      expect(
        runAppNotes(plan({ api: web(CONCURRENCY) }, { saved: [onCloudRun()] })),
      ).toEqual([]);
    });

    it('plans reopening it as the line back to Cloudgate’s ingress', () => {
      const outcome = plan({ api: web() }, { saved: [onCloudRun(CLOSED)] });
      expect(nativeFields(stepOf(outcome))).toEqual([
        {
          field: `${AT}.ingress`,
          from: 'INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER',
          to: 'INGRESS_TRAFFIC_ALL',
          native: true,
          toDefault: true,
        },
      ]);
      expect(runAppNotes(outcome)).toEqual([]);
    });
  });
});

describe('planEnvironment, an exact Cloud Run pair: native.gcp container limits win over size', () => {
  const LIMITS = `${AT}.template.containers.resources.limits`;
  const limits = (set: Record<string, string>): NativeGcpBlock => ({
    [RUN]: { template: { containers: { resources: { limits: set } } } },
  });
  const sized = (gcp?: NativeGcpBlock): Entry => ({
    ...web(gcp),
    size: 'medium',
  });
  const sizeOf = (step: PlanStep | undefined) =>
    step && (step.action === 'create' || step.action === 'change')
      ? step.cloud?.size
      : undefined;
  /** `api` on Cloud Run at the caps `cpu` CPU / `memoryMb` MB, last applied with `stored`. */
  const at = (
    cpu: number,
    memoryMb: number,
    stored?: NativeGcpBlock,
  ): SavedService => {
    const made = onCloudRun(stored) as Extract<
      SavedService,
      { serviceType: 'application' }
    >;
    return {
      ...made,
      settings: {
        ...made.settings,
        cpuLimit: String(cpu * 1e9),
        memoryLimit: String(memoryMb * 1024 * 1024),
      },
    };
  };

  it("reads a partial override as the native half beside the size's other", () => {
    const step = stepOf(plan({ api: sized(limits({ cpu: '2' })) }));

    expect(sizeOf(step)).toMatchObject({
      name: 'medium',
      pair: { runsOn: 'Cloud Run', wording: '2 CPU (native) / 2 GB' },
    });
    expect(nativeFields(step)).toEqual([
      {
        field: `${LIMITS}.cpu`,
        from: null,
        to: '2',
        native: true,
        fromSize: true,
      },
    ]);
    expect(step?.action === 'create' && step.cloud?.nativeGcp).toEqual(
      limits({ cpu: '2' }),
    );
  });

  // Planned clean before, and refused only by Cloud Run at deploy.
  it("refuses a laid pair Cloud Run does not run, naming the native path and what the pair's CPU takes", () => {
    const refusals = (outcome: PlanOutcome) => {
      if (outcome.ok) throw new Error('planned, but a refusal was expected');
      return outcome.refusals.map((refusal) => refusal.message);
    };
    expect(refusals(plan({ api: sized(limits({ cpu: '8' })) }))).toEqual([
      `api.${LIMITS}.cpu: refused - Cloud Run runs no container at 8 CPU / 2 GB: 8 CPU takes 4 GB to 32 GB`,
    ]);
    expect(
      refusals(plan({ api: sized(limits({ cpu: '3', memory: '4Gi' })) })),
    ).toEqual([
      `api.${LIMITS}.cpu and api.${LIMITS}.memory: refused - Cloud Run runs no container at 3 CPU: from one CPU up its count is one of 1, 2, 4, 6, 8`,
    ]);
    // No size: the other half is the caps it runs at.
    expect(
      refusals(
        plan({ api: web(limits({ memory: '6Gi' })) }, { saved: [at(1, 512)] }),
      ),
    ).toEqual([
      `api.${LIMITS}.memory: refused - Cloud Run runs no container at 1 CPU / 6 GB: 1 CPU takes at most 4 GB`,
    ]);
    // Under one CPU is Google's to judge.
    expect(stepOf(plan({ api: sized(limits({ cpu: '0.5' })) }))).toBeDefined();
  });

  it('marks both halves when native sets both, and says nothing of the size being rounded up', () => {
    const step = stepOf(
      plan({
        api: {
          ...web(limits({ cpu: '4', memory: '8Gi' })),
          size: { cpu: 3, memory: '1 GB' },
        },
      }),
    );

    expect(sizeOf(step)?.pair).toMatchObject({
      wording: '4 CPU (native) / 8 GB (native)',
    });
    expect(sizeOf(step)?.pair).not.toHaveProperty('roundedUpFrom');
  });

  it("taken out with a size, falls back to the size's half", () => {
    const step = stepOf(
      plan({ api: sized() }, { saved: [at(1, 2048, limits({ cpu: '2' }))] }),
    );

    expect(nativeFields(step)).toEqual([
      {
        field: `${LIMITS}.cpu`,
        from: '2',
        to: '1',
        native: true,
        toSize: true,
      },
    ]);
  });

  it("taken out with no size, stays at the caps its Apply wrote and is the console's", () => {
    const step = stepOf(
      plan({ api: web() }, { saved: [at(2, 512, limits({ cpu: '2' }))] }),
    );

    expect(nativeFields(step)).toEqual([
      {
        field: `${LIMITS}.cpu`,
        from: '2',
        to: '2',
        native: true,
        toConsole: true,
      },
    ]);
  });

  it("plans the size's own pair on AWS and on a Server, where native.gcp is checked only", () => {
    const onAws = stepOf(
      plan({ api: sized(limits({ cpu: '2' })) }, { cloud: 'aws' }),
    );
    expect(sizeOf(onAws)?.pair.wording).not.toContain('native');

    const onServer = stepOf(
      plan(
        { api: sized(limits({ cpu: '2' })) },
        { deployTarget: { kind: 'platform-host' } },
      ),
    );
    expect(nativeFields(onServer)).toEqual([]);
    expect(onServer?.action === 'create' && onServer.fields).toContainEqual({
      field: 'size',
      from: null,
      to: 'medium',
    });
  });
});
