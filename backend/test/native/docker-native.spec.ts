import {
  blameNativeDocker,
  NATIVE_DOCKER_KEYS,
  nativeDockerBlockOf,
  nativeDockerColumns,
  nativeDockerDiffs,
  nativeDockerPathOf,
  nativeDockerRefusals,
  openDockerKeys,
  storedDockerSettings,
} from '../../src/native/docker-native';
import type { NativeDockerBlock } from '../../src/native/docker-native';

/**
 * `native.docker`, the home of the seven Swarm settings a Project
 * config entry owns on a Server (ADR-0044 rules 1, 6, 9).
 */
describe('nativeDockerRefusals', () => {
  const messages = (kind: string, block: NativeDockerBlock) =>
    nativeDockerRefusals('api', kind, block).map((refusal) => refusal.message);

  it('takes the seven keys on a web with nothing locked', () => {
    expect(
      messages('web', {
        Labels: { 'com.example.team': 'payments' },
        HealthCheck: { Test: ['CMD', 'true'], Retries: 3 },
        RestartPolicy: { Condition: 'on-failure' },
        UpdateConfig: { Order: 'stop-first', FailureAction: 'pause' },
        RollbackConfig: { Order: 'start-first' },
        StopGracePeriod: 20_000_000_000,
        Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 2048 }],
      }),
    ).toEqual([]);
  });

  it('refuses a key outside the seven by name', () => {
    expect(messages('web', { Healthcheck: {} })).toEqual([
      'api.native.docker.Healthcheck: refused - native.docker takes only Labels, HealthCheck, RestartPolicy, UpdateConfig, RollbackConfig, StopGracePeriod, Ulimits',
    ]);
  });

  it.each([
    ['Privileged', /tenant/],
    ['CapAdd', /tenant/],
    ['Mounts', /host path/],
    ['Networks', /networks/],
    ['EndpointSpec', /port settings/],
    ['Mode', /replica count/],
    ['Placement', /names a host/],
    ['Resources', /size/],
  ])('refuses the never-list key %s with its reason', (key, reason) => {
    const [refusal] = nativeDockerRefusals('api', 'web', { [key]: true });
    expect(refusal.at).toBe(`api.native.docker.${key}`);
    expect(refusal.message).toMatch(
      new RegExp(`^api\\.native\\.docker\\.${key}: refused - `),
    );
    expect(refusal.message).toMatch(reason);
  });

  it.each(['NanoCPUs', 'MemoryBytes', 'Memory', 'CPUs'])(
    'refuses %s as CPU or memory, which only size sets',
    (key) => {
      expect(messages('web', { [key]: 1 })).toEqual([
        `api.native.docker.${key}: refused - CPU and memory have no native key: size is the one way to set them`,
      ]);
    },
  );

  it('refuses each reserved label namespace by its full path', () => {
    expect(
      messages('web', {
        Labels: {
          'traefik.http.routers.x': 'Host(`victim.example.com`)',
          'com.docker.compose.project': 'other',
          'io.cloudgate.environment': 'forged',
        },
      }),
    ).toEqual([
      expect.stringMatching(
        /^api\.native\.docker\.Labels\."traefik\.http\.routers\.x": refused - .*traefik/,
      ),
      expect.stringMatching(
        /^api\.native\.docker\.Labels\."com\.docker\.compose\.project": refused - .*com\.docker/,
      ),
      expect.stringMatching(
        /^api\.native\.docker\.Labels\."io\.cloudgate\.environment": refused - .*io\.cloudgate/,
      ),
    ]);
  });

  it.each(['postgres', 'mysql', 'redis'])(
    'refuses start-first on a %s, and not on a web',
    (kind) => {
      const block = {
        UpdateConfig: { Order: 'start-first' },
        RollbackConfig: { Order: 'start-first' },
      };
      expect(messages(kind, block)).toEqual([
        expect.stringMatching(
          /^api\.native\.docker\.UpdateConfig\.Order "start-first": refused - .*stop-first/,
        ),
        expect.stringMatching(
          /^api\.native\.docker\.RollbackConfig\.Order "start-first": refused - .*stop-first/,
        ),
      ]);
      expect(messages('web', block)).toEqual([]);
    },
  );

  it('refuses a value outside each of Docker’s lists', () => {
    expect(
      messages('worker', {
        RestartPolicy: { Condition: 'always' },
        UpdateConfig: { FailureAction: 'retry', Order: 'first' },
      }),
    ).toEqual([
      'api.native.docker.RestartPolicy.Condition "always": refused - Docker takes only none, on-failure or any here',
      'api.native.docker.UpdateConfig.Order "first": refused - Docker takes only stop-first or start-first here',
      'api.native.docker.UpdateConfig.FailureAction "retry": refused - Docker takes only pause, continue or rollback here',
    ]);
  });

  it('takes on a cron the keys it opens, and refuses the others by path', () => {
    expect(
      nativeDockerRefusals('job', 'cron', {
        Labels: { team: 'billing' },
        StopGracePeriod: 1,
        Ulimits: [],
      }),
    ).toEqual([]);
    expect(
      nativeDockerRefusals('job', 'cron', {
        HealthCheck: {},
        RestartPolicy: { Condition: 'always' },
        UpdateConfig: {},
        RollbackConfig: {},
      }).map((refusal) => refusal.at),
    ).toEqual([
      'job.native.docker.HealthCheck',
      'job.native.docker.RestartPolicy',
      'job.native.docker.UpdateConfig',
      'job.native.docker.RollbackConfig',
    ]);
  });

  it('takes only labels on a bucket', () => {
    expect(
      nativeDockerRefusals('files', 'bucket', { Labels: { team: 'data' } }),
    ).toEqual([]);
    expect(
      nativeDockerRefusals('files', 'bucket', {
        StopGracePeriod: 1,
        Ulimits: [],
      }).map((refusal) => refusal.at),
    ).toEqual([
      'files.native.docker.StopGracePeriod',
      'files.native.docker.Ulimits',
    ]);
  });

  it('records each kind’s open keys for the census', () => {
    expect(openDockerKeys('cron')).toEqual([
      'Labels',
      'StopGracePeriod',
      'Ulimits',
    ]);
    expect(openDockerKeys('bucket')).toEqual(['Labels']);
    expect(openDockerKeys('static')).toEqual(NATIVE_DOCKER_KEYS);
  });

  it('refuses nothing when the entry writes no block', () => {
    expect(nativeDockerRefusals('job', 'cron', undefined)).toEqual([]);
  });
});

describe('nativeDockerDiffs', () => {
  it('lists one native line per changed field, old → new, in the file’s spelling', () => {
    expect(
      nativeDockerDiffs(
        'web',
        { HealthCheck: { Test: ['CMD', 'true'], Retries: 5 } },
        { HealthCheck: { Test: ['CMD', 'true'], Retries: 3 } },
      ),
    ).toEqual([
      {
        field: 'native.docker.HealthCheck.Retries',
        from: 3,
        to: 5,
        native: true,
      },
    ]);
  });

  it('shows a removed key returning to the kind’s default, none or Cloudgate’s', () => {
    expect(
      nativeDockerDiffs('web', undefined, {
        HealthCheck: { Retries: 3 },
        UpdateConfig: {
          Parallelism: 1,
          Order: 'start-first',
          FailureAction: 'pause',
        },
      }),
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

  it('keeps Cloudgate’s other update fields when one is written', () => {
    expect(
      nativeDockerDiffs('web', { UpdateConfig: { Delay: 5_000_000_000 } }, {}),
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

  it('plans no line for a stored value equal to the default it stands for', () => {
    expect(
      nativeDockerDiffs('postgres', undefined, {
        UpdateConfig: {
          Parallelism: 1,
          Order: 'stop-first',
          FailureAction: 'rollback',
        },
        StopGracePeriod: 30_000_000_000,
      }),
    ).toEqual([]);
  });

  it('reads a database’s stop grace period default, and a label and ulimits whole', () => {
    expect(
      nativeDockerDiffs(
        'redis',
        {
          Labels: { 'com.example.team': 'cache' },
          Ulimits: [{ Name: 'nofile', Soft: 1, Hard: 2 }],
        },
        { StopGracePeriod: 60_000_000_000 },
      ),
    ).toEqual([
      {
        field: 'native.docker.Labels."com.example.team"',
        from: null,
        to: 'cache',
        native: true,
        fromDefault: true,
      },
      {
        field: 'native.docker.StopGracePeriod',
        from: 60_000_000_000,
        to: 30_000_000_000,
        native: true,
        toDefault: true,
      },
      {
        field: 'native.docker.Ulimits',
        from: null,
        to: [{ Name: 'nofile', Soft: 1, Hard: 2 }],
        native: true,
        fromDefault: true,
      },
    ]);
  });
});

describe('nativeDockerColumns', () => {
  it('writes each of the seven, null where the block writes none', () => {
    expect(nativeDockerColumns('web', undefined)).toEqual({
      labelsSwarm: null,
      healthCheckSwarm: null,
      restartPolicySwarm: null,
      updateConfigSwarm: null,
      rollbackConfigSwarm: null,
      stopGracePeriodSwarm: null,
      ulimitsSwarm: null,
    });
  });

  it('stores an update with the kind’s parallelism and order filled in', () => {
    expect(
      nativeDockerColumns('web', { UpdateConfig: { Delay: 5 } })
        .updateConfigSwarm,
    ).toEqual({
      Parallelism: 1,
      Order: 'start-first',
      FailureAction: 'rollback',
      Delay: 5,
    });
    expect(
      nativeDockerColumns('mysql', { RollbackConfig: { Monitor: 7 } })
        .rollbackConfigSwarm,
    ).toEqual({ Parallelism: 1, Order: 'stop-first', Monitor: 7 });
  });

  it('reads back as the block it wrote, so the next plan has no line', () => {
    const block: NativeDockerBlock = {
      HealthCheck: { Test: ['CMD', 'true'], Interval: 10 },
      UpdateConfig: { Delay: 5 },
      Labels: { team: 'a' },
    };
    const stored = storedDockerSettings(nativeDockerColumns('web', block));
    expect(nativeDockerDiffs('web', block, stored)).toEqual([]);
  });

  it('reads no stored settings when none is set', () => {
    expect(
      storedDockerSettings(nativeDockerColumns('web', undefined)),
    ).toBeUndefined();
  });
});

describe('nativeDockerBlockOf', () => {
  it('writes what the stored settings set, leaving out each value that is the kind’s default', () => {
    expect(
      nativeDockerBlockOf('web', {
        Labels: { team: 'a' },
        HealthCheck: { Test: ['CMD', 'true'], Interval: 10 },
        UpdateConfig: {
          Parallelism: 1,
          Order: 'start-first',
          FailureAction: 'rollback',
          Delay: 5,
        },
        RollbackConfig: { Parallelism: 1, Order: 'start-first' },
        StopGracePeriod: 20,
        Ulimits: [{ Name: 'nofile', Soft: 1, Hard: 2 }],
      }),
    ).toEqual({
      Labels: { team: 'a' },
      HealthCheck: { Test: ['CMD', 'true'], Interval: 10 },
      UpdateConfig: { Delay: 5 },
      StopGracePeriod: 20,
      Ulimits: [{ Name: 'nofile', Soft: 1, Hard: 2 }],
    });
  });

  it('writes nothing for settings that are all the kind’s defaults', () => {
    expect(
      nativeDockerBlockOf('postgres', {
        UpdateConfig: { Parallelism: 1, Order: 'stop-first' },
        StopGracePeriod: 30_000_000_000,
        Labels: {},
        Ulimits: [],
      }),
    ).toBeUndefined();
    expect(nativeDockerBlockOf('web', undefined)).toBeUndefined();
  });

  it('plans no line against the settings it was written from', () => {
    const stored = {
      UpdateConfig: { Parallelism: 2, Order: 'start-first' },
      StopGracePeriod: 30_000_000_000,
    } as const;
    const block = nativeDockerBlockOf('web', stored);
    expect(block).toEqual({
      UpdateConfig: { Parallelism: 2 },
      StopGracePeriod: 30_000_000_000,
    });
    expect(nativeDockerDiffs('web', block, stored)).toEqual([]);
  });
});

describe('nativeDockerBlockOf on a cron and a bucket', () => {
  it('writes only the keys the kind takes', () => {
    const stored = {
      Labels: { team: 'a' },
      HealthCheck: { Test: ['CMD', 'true'] },
      RestartPolicy: { Condition: 'any' },
      StopGracePeriod: 20,
      Ulimits: [{ Name: 'nofile', Soft: 1, Hard: 2 }],
    } as const;
    expect(nativeDockerBlockOf('cron', stored)).toEqual({
      Labels: { team: 'a' },
      StopGracePeriod: 20,
      Ulimits: [{ Name: 'nofile', Soft: 1, Hard: 2 }],
    });
    expect(nativeDockerBlockOf('bucket', stored)).toEqual({
      Labels: { team: 'a' },
    });
    expect(
      nativeDockerBlockOf('bucket', { HealthCheck: { Test: ['NONE'] } }),
    ).toBeUndefined();
  });
});

describe('nativeDockerPathOf', () => {
  it('reads a native line’s field back into its path under native.docker', () => {
    expect(nativeDockerPathOf('native.docker.HealthCheck.Retries')).toEqual([
      'HealthCheck',
      'Retries',
    ]);
    expect(nativeDockerPathOf('native.docker.StopGracePeriod')).toEqual([
      'StopGracePeriod',
    ]);
    expect(
      nativeDockerPathOf('native.docker.Labels."com.example.team"'),
    ).toEqual(['Labels', 'com.example.team']);
  });

  it('is null for a field that is no native.docker line', () => {
    expect(nativeDockerPathOf('port')).toBeNull();
    expect(nativeDockerPathOf('env.API_KEY')).toBeNull();
  });

  it('reads every line nativeDockerDiffs writes', () => {
    const fields = nativeDockerDiffs(
      'web',
      { Labels: { 'a.b': 'c' }, UpdateConfig: { Delay: 5 }, Ulimits: [] },
      undefined,
    ).map((diff) => nativeDockerPathOf(diff.field));
    expect(fields).toEqual([
      ['Labels', 'a.b'],
      ['UpdateConfig', 'Delay'],
    ]);
  });
});

describe('blameNativeDocker', () => {
  it('names the native path when Docker refuses a setting the Service sets', () => {
    const blamed = blameNativeDocker(
      new Error('invalid ulimit type: nofiles'),
      { ulimitsSwarm: [{ Name: 'nofiles', Soft: 1, Hard: 1 }] },
    );
    expect((blamed as Error).message).toBe(
      "Docker refused this Service's native.docker.Ulimits: invalid ulimit type: nofiles",
    );
  });

  it('leaves any other refusal as Docker said it', () => {
    const error = new Error('invalid ulimit type: nofiles');
    expect(blameNativeDocker(error, { ulimitsSwarm: null })).toBe(error);
    const other = new Error('no such image');
    expect(blameNativeDocker(other, { ulimitsSwarm: [] })).toBe(other);
  });
});
