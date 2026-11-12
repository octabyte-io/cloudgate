import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import {
  nativeDockerColumns,
  openDockerColumns,
  storedDockerSettings,
} from '../../src/native/docker-native';
import type { DockerSettings } from '../../src/native/docker-native';
import type {
  DeployTarget,
  FieldDiff,
  PlanOutcome,
  PlanStep,
  SavedService,
} from '../../src/project-config';

/**
 * `native.docker` on a Project config entry, through the planner —
 * checked on every plan, planned as native lines under the Service's
 * `change` step, and "absent means default" (ADR-0044 rules 1, 6, 9).
 */

const PLATFORM: DeployTarget = { kind: 'platform-host' };
const CLOUD: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-1',
  region: 'eu-west-1',
};

function plan(
  text: string,
  saved: SavedService[] = [],
  deployTarget: DeployTarget = PLATFORM,
): PlanOutcome {
  const parsed = parseProjectConfig(text);
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal.message}`);
  return planEnvironment({
    config: parsed.config,
    saved,
    deployTarget,
    context: { previous: null },
  });
}

function steps(...args: Parameters<typeof plan>): readonly PlanStep[] {
  const outcome = plan(...args);
  if (!outcome.ok) {
    throw new Error(
      `refused: ${outcome.refusals.map((r) => r.message).join('; ')}`,
    );
  }
  return outcome.steps;
}

function refusals(...args: Parameters<typeof plan>): string[] {
  const outcome = plan(...args);
  if (outcome.ok) throw new Error('planned, but a refusal was expected');
  return outcome.refusals.map((refusal) => refusal.message);
}

/** The native lines of the one step `configName` has. */
function nativeLines(
  configName: string,
  ...args: Parameters<typeof plan>
): FieldDiff[] {
  const step = steps(...args).find(
    (one) =>
      (one.action === 'change' || one.action === 'create') &&
      one.configName === configName,
  );
  if (!step || (step.action !== 'change' && step.action !== 'create')) {
    return [];
  }
  return step.fields.filter((field) => field.native);
}

/** A `web` as a console create leaves it, with these Swarm settings stored. */
function savedWeb(
  configName: string,
  docker?: DockerSettings,
  kind: 'web' | 'worker' | 'static' | 'cron' = 'web',
): SavedService {
  return {
    serviceType: 'application',
    serviceId: `app-${configName}`,
    name: `App ${configName}`,
    configName,
    ...(docker ? { docker } : {}),
    settings: {
      configKind: kind,
      description: null,
      cpuLimit: null,
      memoryLimit: null,
      command: kind === 'cron' ? 'run' : null,
      args: null,
      port: 3000,
      cronSchedule: kind === 'cron' ? '0 * * * *' : null,
      cronTimezone: kind === 'cron' ? 'UTC' : null,
      cronTimeoutSeconds: kind === 'cron' ? 3600 : null,
      sourceType: 'github',
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
      dockerImage: null,
      buildType: kind === 'static' ? 'static' : 'nixpacks',
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

function savedPostgres(
  configName: string,
  docker?: DockerSettings,
): SavedService {
  return {
    serviceType: 'postgres',
    serviceId: `pg-${configName}`,
    name: `Postgres ${configName}`,
    configName,
    ...(docker ? { docker } : {}),
    settings: {
      description: null,
      cpuLimit: null,
      memoryLimit: null,
      dockerImage: 'postgres:18',
      databaseName: 'app',
      databaseUser: 'app',
    },
    variables: { env: [] },
  };
}

/** A config of one entry, `native.docker` as YAML under it. */
function config(name: string, kind: string, docker?: string): string {
  const native = docker
    ? `\n    native:\n      docker:\n${docker
        .trim()
        .split('\n')
        .map((line) => `        ${line}`)
        .join('\n')}`
    : '';
  const command =
    kind === 'cron' ? '\n    command: run\n    schedule: "0 * * * *"' : '';
  return `version: 1\nservices:\n  ${name}:\n    kind: ${kind}${command}${native}\n`;
}

const HEALTH_CHECK = `
HealthCheck:
  Test: [CMD, curl, -f, http://localhost:3000/health]
  Retries: 5
`;

describe('planEnvironment native.docker', () => {
  describe('the plan', () => {
    it('plans a web’s health check as native lines under its change step, in the file’s spelling', () => {
      const [step] = steps(config('web', 'web', HEALTH_CHECK), [
        savedWeb('web', { HealthCheck: { Retries: 3 } }),
      ]);

      expect(step).toMatchObject({ action: 'change', configName: 'web' });
      expect(step.action === 'change' && step.fields).toEqual([
        {
          field: 'native.docker.HealthCheck.Test',
          from: null,
          to: ['CMD', 'curl', '-f', 'http://localhost:3000/health'],
          native: true,
          fromDefault: true,
        },
        {
          field: 'native.docker.HealthCheck.Retries',
          from: 3,
          to: 5,
          native: true,
        },
      ]);
    });

    it('plans nothing once Apply has written the block to the Swarm columns', () => {
      const parsed = parseProjectConfig(config('web', 'web', HEALTH_CHECK));
      if (!parsed.ok) throw new Error(parsed.refusal.message);
      const entry = parsed.config.services.web;
      const written = storedDockerSettings(
        nativeDockerColumns(
          'web',
          'native' in entry ? entry.native?.docker : undefined,
        ),
      );

      expect(
        steps(config('web', 'web', HEALTH_CHECK), [savedWeb('web', written)]),
      ).toEqual([]);
    });

    it('plans one update field over Cloudgate’s others, which keep their defaults', () => {
      expect(
        nativeLines(
          'web',
          config('web', 'web', 'UpdateConfig:\n  Delay: 5000000000'),
          [savedWeb('web')],
        ),
      ).toEqual([
        {
          field: 'native.docker.UpdateConfig.Delay',
          from: null,
          to: 5_000_000_000,
          native: true,
          fromDefault: true,
        },
      ]);
    });

    it('plans a removed key back to the kind’s default', () => {
      expect(
        nativeLines('web', config('web', 'web'), [
          savedWeb('web', {
            HealthCheck: { Retries: 3 },
            UpdateConfig: {
              Parallelism: 1,
              Order: 'start-first',
              FailureAction: 'pause',
            },
          }),
        ]),
      ).toEqual([
        {
          field: 'native.docker.HealthCheck.Retries',
          from: 3,
          to: null,
          native: true,
          toDefault: true,
        },
        {
          field: 'native.docker.UpdateConfig.FailureAction',
          from: 'pause',
          to: 'rollback',
          native: true,
          toDefault: true,
        },
      ]);
    });

    it('shows a described Service’s stored non-default settings returning to the defaults when it writes no block', () => {
      const [step] = steps(config('pg-1', 'postgres'), [
        savedPostgres('pg-1', {
          Labels: { 'com.example.team': 'data' },
          StopGracePeriod: 60_000_000_000,
        }),
      ]);
      expect(step.action === 'change' && step.fields).toEqual([
        {
          field: 'native.docker.Labels."com.example.team"',
          from: 'data',
          to: null,
          native: true,
          toDefault: true,
        },
        {
          field: 'native.docker.StopGracePeriod',
          from: 60_000_000_000,
          to: 30_000_000_000,
          native: true,
          toDefault: true,
        },
      ]);
    });

    it('lists a create’s native settings beyond the kind’s defaults', () => {
      expect(
        nativeLines(
          'web',
          config('web', 'web', 'StopGracePeriod: 20000000000'),
        ),
      ).toEqual([
        {
          field: 'native.docker.StopGracePeriod',
          from: null,
          to: 20_000_000_000,
          native: true,
          fromDefault: true,
        },
      ]);
    });
  });

  describe('the check', () => {
    it.each([
      [
        'an unknown key',
        'Healthcheck: {}',
        /^web\.native\.docker\.Healthcheck: refused - native\.docker takes only /,
      ],
      [
        'a never-list key',
        'Privileged: true',
        /^web\.native\.docker\.Privileged: refused - .*tenant/,
      ],
      [
        'CPU',
        'NanoCPUs: 1000000000',
        /^web\.native\.docker\.NanoCPUs: refused - .*size/,
      ],
      [
        'memory',
        'Resources: {}',
        /^web\.native\.docker\.Resources: refused - .*size/,
      ],
      [
        'a traefik label',
        'Labels:\n  traefik.http.routers.x: "Host(`victim.example.com`)"',
        /^web\.native\.docker\.Labels\."traefik\.http\.routers\.x": refused - .*traefik/,
      ],
      [
        'a com.docker label',
        'Labels:\n  com.docker.stack.namespace: other',
        /^web\.native\.docker\.Labels\."com\.docker\.stack\.namespace": refused - .*com\.docker/,
      ],
      [
        'an io.cloudgate label',
        'Labels:\n  io.cloudgate.environment: forged',
        /^web\.native\.docker\.Labels\."io\.cloudgate\.environment": refused - .*io\.cloudgate/,
      ],
      [
        'an out-of-list value',
        'RestartPolicy:\n  Condition: always',
        /^web\.native\.docker\.RestartPolicy\.Condition "always": refused - Docker takes only none, on-failure or any here$/,
      ],
    ])(
      'refuses %s by its full path, with a reason',
      (_what, docker, message) => {
        expect(
          refusals(config('web', 'web', docker), [savedWeb('web')]),
        ).toEqual([expect.stringMatching(message)]);
      },
    );

    it('refuses a database’s start-first update by its full path', () => {
      expect(
        refusals(
          config('pg-1', 'postgres', 'UpdateConfig:\n  Order: start-first'),
        ),
      ).toEqual([
        expect.stringMatching(
          /^pg-1\.native\.docker\.UpdateConfig\.Order "start-first": refused - .*stop-first/,
        ),
      ]);
    });

    it('checks the block on a cloud Deploy target too, where it is never used', () => {
      expect(
        refusals(config('web', 'web', 'Privileged: true'), [], CLOUD),
      ).toEqual([expect.stringMatching(/^web\.native\.docker\.Privileged: /)]);
    });
  });
});

/** A bucket on a Server, with these Garage labels stored. */
function savedBucket(
  configName: string,
  docker?: DockerSettings,
  existing = false,
): SavedService {
  return {
    serviceType: 'bucket',
    serviceId: `bucket-${configName}`,
    name: configName,
    configName,
    ...(docker ? { docker } : {}),
    settings: { description: null, bucketName: `${configName}-a1b2c3d4` },
    variables: { env: [] },
    ...(existing
      ? {
          existing: {
            cloudAccountId: 'ca-1',
            region: 'eu-west-1',
            bucketName: `${configName}-a1b2c3d4`,
          },
        }
      : {}),
  };
}

/** What Apply stores for an entry's block, as the next plan reads it back. */
function applied(kind: string, text: string, name: string): DockerSettings {
  const parsed = parseProjectConfig(text);
  if (!parsed.ok) throw new Error(parsed.refusal.message);
  const entry = parsed.config.services[name];
  const block = 'native' in entry ? entry.native?.docker : undefined;
  return (
    storedDockerSettings({
      ...nativeDockerColumns(kind, undefined),
      ...openDockerColumns(kind, block),
    }) ?? {}
  );
}

const CRON_NATIVE = `
Labels:
  com.example.team: billing
StopGracePeriod: 20000000000
Ulimits:
  - Name: nofile
    Soft: 1024
    Hard: 2048
`;

describe('planEnvironment native.docker on a cron and a bucket', () => {
  describe('a cron', () => {
    it('plans its labels, stop grace and ulimits as native lines', () => {
      expect(
        nativeLines('job', config('job', 'cron', CRON_NATIVE), [
          savedWeb('job', undefined, 'cron'),
        ]),
      ).toEqual([
        {
          field: 'native.docker.Labels."com.example.team"',
          from: null,
          to: 'billing',
          native: true,
          fromDefault: true,
        },
        {
          field: 'native.docker.StopGracePeriod',
          from: null,
          to: 20_000_000_000,
          native: true,
          fromDefault: true,
        },
        {
          field: 'native.docker.Ulimits',
          from: null,
          to: [{ Name: 'nofile', Soft: 1024, Hard: 2048 }],
          native: true,
          fromDefault: true,
        },
      ]);
    });

    it('lists them on its create too', () => {
      expect(
        nativeLines('job', config('job', 'cron', CRON_NATIVE)).map(
          (line) => line.field,
        ),
      ).toEqual([
        'native.docker.Labels."com.example.team"',
        'native.docker.StopGracePeriod',
        'native.docker.Ulimits',
      ]);
    });

    it('plans nothing once Apply has written them', () => {
      const text = config('job', 'cron', CRON_NATIVE);
      expect(
        steps(text, [savedWeb('job', applied('cron', text, 'job'), 'cron')]),
      ).toEqual([]);
    });

    it('plans a removed key back to the kind’s default', () => {
      expect(
        nativeLines('job', config('job', 'cron'), [
          savedWeb(
            'job',
            applied('cron', config('job', 'cron', CRON_NATIVE), 'job'),
            'cron',
          ),
        ]).map(({ field, to, toDefault }) => [field, to, toDefault]),
      ).toEqual([
        ['native.docker.Labels."com.example.team"', null, true],
        ['native.docker.StopGracePeriod', null, true],
        ['native.docker.Ulimits', null, true],
      ]);
    });

    it('never compares a key it refuses, whose stored column is Cloudgate’s', () => {
      expect(
        steps(config('job', 'cron'), [
          savedWeb(
            'job',
            {
              HealthCheck: { Retries: 3 },
              RestartPolicy: { Condition: 'any' },
              UpdateConfig: { Parallelism: 2 },
            },
            'cron',
          ),
        ]),
      ).toEqual([]);
    });

    it.each([
      [
        'HealthCheck',
        'HealthCheck:\n  Retries: 3',
        'a run is judged by its exit code, and a failing health check would kill it mid-command (AWS and Google Cloud runs have none)',
      ],
      [
        'RestartPolicy',
        'RestartPolicy:\n  Condition: always',
        'a run is never retried; Cloudgate runs it with Condition none',
      ],
      [
        'UpdateConfig',
        'UpdateConfig:\n  Order: sideways',
        'a run is a one-off job with no copies to update',
      ],
      [
        'RollbackConfig',
        'RollbackConfig:\n  Parallelism: 2',
        'a run is a one-off job with nothing to roll back',
      ],
    ])(
      'refuses its %s by full path with the reason, once',
      (key, docker, reason) => {
        expect(refusals(config('job', 'cron', docker))).toEqual([
          `job.native.docker.${key}: refused - ${reason}`,
        ]);
      },
    );
  });

  describe('a bucket', () => {
    const LABELS = 'Labels:\n  com.example.backup: nightly';

    it('plans its labels as a native line on a Server', () => {
      expect(
        nativeLines('files', config('files', 'bucket', LABELS), [
          savedBucket('files'),
        ]),
      ).toEqual([
        {
          field: 'native.docker.Labels."com.example.backup"',
          from: null,
          to: 'nightly',
          native: true,
          fromDefault: true,
        },
      ]);
    });

    it('plans nothing once Apply has written its labels column', () => {
      const text = config('files', 'bucket', LABELS);
      expect(
        steps(text, [savedBucket('files', applied('bucket', text, 'files'))]),
      ).toEqual([]);
    });

    it('plans a removed label back to none', () => {
      expect(
        nativeLines('files', config('files', 'bucket'), [
          savedBucket('files', { Labels: { 'com.example.backup': 'nightly' } }),
        ]),
      ).toEqual([
        {
          field: 'native.docker.Labels."com.example.backup"',
          from: 'nightly',
          to: null,
          native: true,
          toDefault: true,
        },
      ]);
    });

    it('never plans its Garage’s stop-first update, rollback or 30 s grace', () => {
      expect(
        nativeLines('files', config('files', 'bucket'), [savedBucket('files')]),
      ).toEqual([]);
      expect(nativeLines('files', config('files', 'bucket'))).toEqual([]);
    });

    it('plans no native line on an existing bucket, which Cloudgate never changes', () => {
      const planned = steps(
        config('files', 'bucket', LABELS),
        [savedBucket('files', undefined, true)],
        CLOUD,
      );
      expect(planned).toEqual([
        expect.objectContaining({ action: 'change', configName: 'files' }),
      ]);
      expect(
        planned.flatMap((step) =>
          step.action === 'change' ? step.fields : [],
        ),
      ).toEqual([]);
    });

    it.each([
      [
        'HealthCheck',
        'HealthCheck:\n  Retries: 3',
        "Garage is Cloudgate's pinned image with no shell, and Cloudgate checks it is ready itself",
      ],
      [
        'RestartPolicy',
        'RestartPolicy:\n  Condition: any',
        'every Service linking the bucket needs its Garage up, so Cloudgate keeps the restart policy',
      ],
      [
        'UpdateConfig',
        'UpdateConfig:\n  Order: start-first',
        "Garage's image is Cloudgate's pin and its one copy updates stop-first, as a database's does",
      ],
      [
        'RollbackConfig',
        'RollbackConfig:\n  Order: stop-first',
        "Garage's image is Cloudgate's pin and its one copy rolls back stop-first, as a database's does",
      ],
      [
        'StopGracePeriod',
        'StopGracePeriod: 1000000000',
        "Garage gets the database's 30 s to flush its files, and a shorter grace can corrupt the bucket",
      ],
      [
        'Ulimits',
        'Ulimits: []',
        "a bucket runs no code of the operator's, and Garage's limits are Cloudgate's along with its pinned image and config (ADR-0037)",
      ],
    ])('refuses its %s by full path with the reason', (key, docker, reason) => {
      expect(refusals(config('files', 'bucket', docker))).toEqual([
        `files.native.docker.${key}: refused - ${reason}`,
      ]);
    });
  });

  describe.each([
    ['cron', 'job'],
    ['bucket', 'files'],
  ])('a %s’s labels', (kind, name) => {
    it.each([
      ['traefik.http.routers.x', /traefik/],
      ['com.docker.stack.namespace', /com\.docker/],
      ['io.cloudgate.environment', /io\.cloudgate/],
    ])('refuses a %s label by its full path', (label, reason) => {
      expect(refusals(config(name, kind, `Labels:\n  ${label}: x`))).toEqual([
        expect.stringMatching(
          new RegExp(
            `^${name}\\.native\\.docker\\.Labels\\.${JSON.stringify(label).replace(/\./g, '\\.')}: refused - .*${reason.source}`,
          ),
        ),
      ]);
    });
  });
});
