import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanInput,
  PlanOutcome,
  PlanStep,
  SavedService,
} from '../../src/project-config';
import type { NativeAwsBlock } from '../../src/native/aws-native';

/**
 * ADR-0044 rule 6: `native.aws` on a Service on ECS as native lines
 * of its step, in the file's spelling, against the block its last Apply
 * laid; a key taken out shows what it returns to. Off AWS the block is
 * checked only and plans nothing.
 */

const AWS: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-1',
  region: 'eu-west-1',
};

type Entry = Record<string, unknown>;

function plan(
  services: Record<string, Entry>,
  deployTarget: DeployTarget,
  more: Partial<PlanInput> = {},
): PlanOutcome {
  const parsed = parseProjectConfig(JSON.stringify({ version: 1, services }));
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal.message}`);
  return planEnvironment({
    config: parsed.config,
    saved: [],
    deployTarget,
    context: { previous: null },
    networks: [{ cloudAccountId: 'ca-1', region: 'eu-west-1' }],
    ...more,
  });
}

function stepOf(
  outcome: PlanOutcome,
  configName = 'api',
): PlanStep | undefined {
  if (!outcome.ok) {
    throw new Error(outcome.refusals.map((r) => r.message).join('; '));
  }
  return outcome.steps.find(
    (step) =>
      'configName' in step &&
      step.configName === configName &&
      (step.action === 'create' || step.action === 'change'),
  );
}

function refusalsOf(outcome: PlanOutcome): string[] {
  if (outcome.ok) throw new Error('planned, but a refusal was expected');
  return outcome.refusals.map((refusal) => refusal.message);
}

function fieldsOf(step: PlanStep | undefined) {
  if (!step || (step.action !== 'create' && step.action !== 'change')) {
    throw new Error('no create or change');
  }
  return step.fields.filter((field) => 'native' in field && field.native);
}

/** `api` on ECS already, as a web with no size and the image nginx. */
function onEcs(kind = 'web', nativeAws?: NativeAwsBlock): SavedService {
  return {
    serviceType: 'application',
    serviceId: 'app-api',
    name: 'App api',
    configName: 'api',
    cloud: {
      cloudAccountId: 'ca-1',
      region: 'eu-west-1',
      linkedRegistries: [],
    },
    ...(nativeAws ? { nativeAws } : {}),
    settings: {
      configKind: kind as 'web',
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

const ECS_SERVICE = {
  'aws_ecs_service.service': {
    health_check_grace_period_seconds: 60,
    enable_execute_command: true,
    deployment_maximum_percent: 150,
    deployment_minimum_healthy_percent: 50,
    deployment_circuit_breaker: { enable: true, rollback: true },
  },
};

const web = (aws?: NativeAwsBlock, kind = 'web'): Entry => ({
  kind,
  source: { image: 'nginx' },
  ...(aws ? { native: { aws } } : {}),
});

const SERVICE = 'native.aws."aws_ecs_service.service"';

describe('planEnvironment native.aws lines on ECS', () => {
  it('plans each native value of a change as its own native line, the side nothing sets Cloudgate’s default', () => {
    const step = stepOf(
      plan({ api: web(ECS_SERVICE) }, AWS, { saved: [onEcs()] }),
    );
    expect(fieldsOf(step)).toEqual([
      {
        field: `${SERVICE}.health_check_grace_period_seconds`,
        from: null,
        to: 60,
        native: true,
        fromDefault: true,
      },
      {
        field: `${SERVICE}.enable_execute_command`,
        from: null,
        to: true,
        native: true,
        fromDefault: true,
      },
      {
        field: `${SERVICE}.deployment_maximum_percent`,
        from: null,
        to: 150,
        native: true,
        fromDefault: true,
      },
      {
        field: `${SERVICE}.deployment_minimum_healthy_percent`,
        from: null,
        to: 50,
        native: true,
        fromDefault: true,
      },
      {
        field: `${SERVICE}.deployment_circuit_breaker.enable`,
        from: null,
        to: true,
        native: true,
        fromDefault: true,
      },
      {
        field: `${SERVICE}.deployment_circuit_breaker.rollback`,
        from: null,
        to: true,
        native: true,
        fromDefault: true,
      },
    ]);
    // Its read lays the block as its deploy will.
    expect(step?.action === 'change' && step.cloud?.native).toEqual(
      ECS_SERVICE,
    );
    expect(step?.action === 'change' && step.cloudRead).toEqual({
      status: 'reading',
    });
  });

  it('plans no change once the applied block is the entry’s', () => {
    expect(
      stepOf(
        plan({ api: web(ECS_SERVICE) }, AWS, {
          saved: [onEcs('web', ECS_SERVICE)],
        }),
      ),
    ).toBeUndefined();
  });

  it("plans one field of a block allowed once, from Cloudgate's value, keeping its others", () => {
    const step = stepOf(
      plan(
        {
          api: web({
            'aws_lb_target_group.service': {
              health_check: { path: '/healthz' },
            },
          }),
        },
        AWS,
        { saved: [onEcs()] },
      ),
    );
    expect(fieldsOf(step)).toEqual([
      {
        field: 'native.aws."aws_lb_target_group.service".health_check.path',
        from: '/',
        to: '/healthz',
        native: true,
        fromDefault: true,
      },
    ]);
  });

  it('plans a removed key back to Cloudgate’s default, showing what it returns to', () => {
    const stored = {
      'aws_ecs_service.service': { health_check_grace_period_seconds: 60 },
      'aws_lb_target_group.service': { health_check: { path: '/healthz' } },
    };
    const step = stepOf(
      plan({ api: web() }, AWS, { saved: [onEcs('web', stored)] }),
    );
    expect(fieldsOf(step)).toEqual([
      {
        field: `${SERVICE}.health_check_grace_period_seconds`,
        from: 60,
        to: null,
        native: true,
        toDefault: true,
      },
      {
        field: 'native.aws."aws_lb_target_group.service".health_check.path',
        from: '/healthz',
        to: '/',
        native: true,
        toDefault: true,
      },
    ]);
    // Its read lays nothing: Cloudgate's definition.
    expect(step?.action === 'change' && step.cloud?.native).toBeUndefined();
  });

  it('plans the container’s fields in ECS spelling, one line each', () => {
    const step = stepOf(
      plan(
        {
          api: web({
            'aws_ecs_task_definition.service': {
              container_definitions: {
                healthCheck: { command: ['CMD-SHELL', 'true'], retries: 5 },
                stopTimeout: 90,
              },
            },
          }),
        },
        AWS,
        { saved: [onEcs()] },
      ),
    );
    const task =
      'native.aws."aws_ecs_task_definition.service".container_definitions';
    expect(fieldsOf(step).map((field) => [field.field, field.to])).toEqual([
      [`${task}.healthCheck.command`, ['CMD-SHELL', 'true']],
      [`${task}.healthCheck.retries`, 5],
      [`${task}.stopTimeout`, 90],
    ]);
  });

  it('plans a create’s native values as lines, and its read lays them', () => {
    const step = stepOf(plan({ api: web(ECS_SERVICE) }, AWS));
    expect(step?.action).toBe('create');
    expect(fieldsOf(step).map((field) => field.field)).toEqual([
      `${SERVICE}.health_check_grace_period_seconds`,
      `${SERVICE}.enable_execute_command`,
      `${SERVICE}.deployment_maximum_percent`,
      `${SERVICE}.deployment_minimum_healthy_percent`,
      `${SERVICE}.deployment_circuit_breaker.enable`,
      `${SERVICE}.deployment_circuit_breaker.rollback`,
    ]);
    expect(step?.action === 'create' && step.cloud?.native).toEqual(
      ECS_SERVICE,
    );
  });

  it.each(['worker', 'web-private'])(
    'plans the same block on a %s through the shared builder',
    (kind) => {
      const step = stepOf(
        plan(
          {
            api: {
              ...web(ECS_SERVICE, kind),
              ...(kind === 'web-private' ? { port: 8080 } : {}),
            },
          },
          AWS,
          {
            saved: [onEcs(kind)],
          },
        ),
      );
      expect(fieldsOf(step)).toHaveLength(6);
      expect(step?.action === 'change' && step.cloud?.native).toEqual(
        ECS_SERVICE,
      );
    },
  );

  it('plans nothing of native.aws on a Server, where it is checked only', () => {
    const outcome = plan({ api: web(ECS_SERVICE) }, { kind: 'platform-host' });
    expect(fieldsOf(stepOf(outcome))).toEqual([]);
  });

  it('plans nothing of native.aws on Google Cloud, where it is checked only', () => {
    const outcome = plan({ api: web(ECS_SERVICE) }, AWS, { cloud: 'gcp' });
    expect(fieldsOf(stepOf(outcome))).toEqual([]);
    const step = stepOf(outcome);
    expect(step?.action === 'create' && step.cloud?.native).toBeUndefined();
  });
});

describe('planEnvironment, an exact Fargate pair: native.aws task cpu and memory win over size', () => {
  const TASK = 'native.aws."aws_ecs_task_definition.service"';
  const sized = (aws?: NativeAwsBlock): Entry => ({
    ...web(aws),
    size: 'medium',
  });
  const sizeOf = (step: PlanStep | undefined) =>
    step && (step.action === 'create' || step.action === 'change')
      ? step.cloud?.size
      : undefined;

  it("reads a partial override as the native half beside the size's other", () => {
    const step = stepOf(
      plan(
        { api: sized({ 'aws_ecs_task_definition.service': { cpu: '512' } }) },
        AWS,
      ),
    );

    expect(sizeOf(step)).toEqual({
      name: 'medium',
      pair: { runsOn: 'Fargate', wording: '0.5 vCPU (native) / 2 GB' },
    });
    expect(fieldsOf(step)).toEqual([
      {
        field: `${TASK}.cpu`,
        from: null,
        to: '512',
        native: true,
        fromSize: true,
      },
    ]);
  });

  // Planned clean before, written to a size-less Service's caps by its
  // Apply, and refused only by RegisterTaskDefinition at deploy.
  it("refuses a laid pair Fargate does not run, naming the native path and what the pair's CPU takes", () => {
    expect(
      refusalsOf(
        plan(
          {
            api: sized({ 'aws_ecs_task_definition.service': { cpu: '2048' } }),
          },
          AWS,
        ),
      ),
    ).toEqual([
      `api.${TASK}.cpu: refused - Fargate runs no task at 2 vCPU / 2 GB: 2 vCPU takes 4 GB to 16 GB, in 1 GB steps`,
    ]);
    expect(
      refusalsOf(
        plan(
          {
            api: web({
              'aws_ecs_task_definition.service': { cpu: '768', memory: '2048' },
            }),
          },
          AWS,
        ),
      ),
    ).toEqual([
      `api.${TASK}.cpu and api.${TASK}.memory: refused - Fargate runs no task at 0.75 vCPU: a task's cpu is one of 256 (0.25 vCPU), 512 (0.5 vCPU), 1024 (1 vCPU), 2048 (2 vCPU), 4096 (4 vCPU), 8192 (8 vCPU), 16384 (16 vCPU)`,
    ]);
  });

  it('checks a size-less Service’s native half against the caps it runs at', () => {
    const made = onEcs() as Extract<
      SavedService,
      { serviceType: 'application' }
    >;
    const running = (memoryGb: number): SavedService => ({
      ...made,
      settings: {
        ...made.settings,
        cpuLimit: String(1e9),
        memoryLimit: String(memoryGb * 1024 * 1024 * 1024),
      },
    });
    const block = { 'aws_ecs_task_definition.service': { cpu: '2048' } };

    expect(
      sizeOf(stepOf(plan({ api: web(block) }, AWS, { saved: [running(4)] })))
        ?.pair.runsOn,
    ).toBe('Fargate');
    expect(
      refusalsOf(plan({ api: web(block) }, AWS, { saved: [running(2)] })),
    ).toEqual([
      `api.${TASK}.cpu: refused - Fargate runs no task at 2 vCPU / 2 GB: 2 vCPU takes 4 GB to 16 GB, in 1 GB steps`,
    ]);
  });

  it("marks both halves when native sets both, and refuses no size above Fargate's largest then", () => {
    const step = stepOf(
      plan(
        {
          api: {
            ...web({
              'aws_ecs_task_definition.service': {
                cpu: '4096',
                memory: '8192',
              },
            }),
            size: { cpu: 64, memory: '512 GB' },
          },
        },
        AWS,
      ),
    );

    expect(sizeOf(step)?.pair.wording).toBe('4 vCPU (native) / 8 GB (native)');
  });

  it("taken out with a size, falls back to the size's half", () => {
    const step = stepOf(
      plan({ api: sized() }, AWS, {
        saved: [
          {
            ...onEcs('web', {
              'aws_ecs_task_definition.service': { cpu: '2048' },
            }),
            settings: {
              ...(
                onEcs() as Extract<SavedService, { serviceType: 'application' }>
              ).settings,
              cpuLimit: String(1e9),
              memoryLimit: String(2 * 1024 * 1024 * 1024),
            },
          } as SavedService,
        ],
      }),
    );

    expect(fieldsOf(step)).toEqual([
      {
        field: `${TASK}.cpu`,
        from: '2048',
        to: '1024',
        native: true,
        toSize: true,
      },
    ]);
  });

  it("taken out with no size, stays at the caps its Apply wrote and is the console's", () => {
    const made = onEcs('web', {
      'aws_ecs_task_definition.service': { cpu: '2048' },
    }) as Extract<SavedService, { serviceType: 'application' }>;
    const step = stepOf(
      plan({ api: web() }, AWS, {
        saved: [
          {
            ...made,
            // Its Apply wrote the pair it ran at to its caps.
            settings: {
              ...made.settings,
              cpuLimit: String(2e9),
              memoryLimit: String(4 * 1024 * 1024 * 1024),
            },
          },
        ],
      }),
    );

    expect(fieldsOf(step)).toEqual([
      {
        field: `${TASK}.cpu`,
        from: '2048',
        to: '2048',
        native: true,
        toConsole: true,
      },
    ]);
  });

  it("plans the size's own pair on Google Cloud, where native.aws is checked only", () => {
    const step = stepOf(
      plan(
        { api: sized({ 'aws_ecs_task_definition.service': { cpu: '2048' } }) },
        AWS,
        { cloud: 'gcp' },
      ),
    );

    expect(sizeOf(step)?.pair.wording).not.toContain('native');
  });
});
