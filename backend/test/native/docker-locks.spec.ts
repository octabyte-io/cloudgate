import { labelsSwarmSchema } from '../../src/applications/swarm.types';
import { buildDatabaseServiceSpec } from '../../src/databases/common/database-spec';
import { generateConfigContainer } from '../../src/deployment-engine/mechanize';
import {
  dockerLockRefusals,
  formatDockerRefusal,
  REFUSED_LABEL_NAMESPACES,
} from '../../src/native/docker-locks';
import { makeApp } from '../deployment-engine/application.fixture';

/**
 * The Docker half of the Locked setting list (ADR-0044 rules 7–9). One
 * list, read by the console's save (the Swarm DTOs) and the deploy (the spec
 * builders); the plan reads it once `native.docker` exists.
 */
describe('dockerLockRefusals', () => {
  it('refuses a label in each reserved namespace, naming the key', () => {
    const refusals = dockerLockRefusals(
      {
        Labels: {
          'traefik.http.routers.x.rule': 'Host(`victim.example.com`)',
          'com.docker.compose.project': 'other',
          'io.cloudgate.environment': 'forged',
          'com.example.team': 'payments',
        },
      },
      'application',
    );

    expect(refusals.map((refusal) => refusal.path)).toEqual([
      ['Labels', 'traefik.http.routers.x.rule'],
      ['Labels', 'com.docker.compose.project'],
      ['Labels', 'io.cloudgate.environment'],
    ]);
    expect(refusals[0].reason).toMatch(/traefik/);
    expect(refusals[1].reason).toMatch(/com\.docker/);
    expect(refusals[2].reason).toMatch(/io\.cloudgate/);
  });

  it('refuses the io.cloudgate namespace whole and case-insensitively, but not a lookalike', () => {
    const refused = (key: string) =>
      dockerLockRefusals({ Labels: { [key]: 'v' } }, 'application').length;

    expect(refused('io.cloudgate')).toBe(1);
    expect(refused('IO.Cloudgate.service')).toBe(1);
    expect(refused('io.cloudgateish.team')).toBe(0);
    expect(refused('com.example.io.cloudgate')).toBe(0);
  });

  it('refuses a start-first update or rollback on a database, and not on an Application', () => {
    const settings = {
      UpdateConfig: { Order: 'start-first' },
      RollbackConfig: { Order: 'start-first' },
    };

    const database = dockerLockRefusals(settings, 'database');
    expect(database.map((refusal) => [refusal.path, refusal.value])).toEqual([
      [['UpdateConfig', 'Order'], 'start-first'],
      [['RollbackConfig', 'Order'], 'start-first'],
    ]);
    expect(database[0].reason).toMatch(/stop-first/);
    expect(database[0].reason).toMatch(/volume/);

    expect(dockerLockRefusals(settings, 'application')).toEqual([]);
  });

  it('takes stop-first on a database', () => {
    expect(
      dockerLockRefusals(
        {
          UpdateConfig: { Order: 'stop-first' },
          RollbackConfig: { Order: 'stop-first' },
        },
        'database',
      ),
    ).toEqual([]);
  });

  // Docker documents these three as fixed lists; a free-text value the
  // Engine would reject (or read as something else) is refused here instead.
  it.each([
    [
      { RestartPolicy: { Condition: 'always' } },
      ['RestartPolicy', 'Condition'],
    ],
    [{ UpdateConfig: { Order: 'blue-green' } }, ['UpdateConfig', 'Order']],
    [{ RollbackConfig: { Order: 'Start-First' } }, ['RollbackConfig', 'Order']],
    [
      { UpdateConfig: { FailureAction: 'retry' } },
      ['UpdateConfig', 'FailureAction'],
    ],
    [
      { RollbackConfig: { FailureAction: 'rollback-ish' } },
      ['RollbackConfig', 'FailureAction'],
    ],
  ])(
    'refuses a value outside Docker’s documented list: %j',
    (settings, path) => {
      const refusals = dockerLockRefusals(settings, 'application');

      expect(refusals).toHaveLength(1);
      expect(refusals[0].path).toEqual(path);
    },
  );

  it('takes every value Docker documents', () => {
    for (const Condition of ['none', 'on-failure', 'any']) {
      expect(
        dockerLockRefusals({ RestartPolicy: { Condition } }, 'application'),
      ).toEqual([]);
    }
    for (const Order of ['stop-first', 'start-first']) {
      for (const FailureAction of ['pause', 'continue', 'rollback']) {
        expect(
          dockerLockRefusals(
            {
              UpdateConfig: { Order, FailureAction },
              RollbackConfig: { Order, FailureAction },
            },
            'application',
          ),
        ).toEqual([]);
      }
    }
  });

  it('refuses nothing in settings that are absent', () => {
    expect(
      dockerLockRefusals(
        {
          Labels: null,
          RestartPolicy: null,
          UpdateConfig: null,
          RollbackConfig: undefined,
        },
        'database',
      ),
    ).toEqual([]);
    expect(dockerLockRefusals({ RestartPolicy: {} }, 'database')).toEqual([]);
  });
});

describe('formatDockerRefusal', () => {
  it('names a label by its quoted key and a value by its path and value, with the reason', () => {
    const [label] = dockerLockRefusals(
      { Labels: { 'io.cloudgate.x': 'v' } },
      'application',
    );
    const [order] = dockerLockRefusals(
      { UpdateConfig: { Order: 'start-first' } },
      'database',
    );

    expect(formatDockerRefusal(label)).toMatch(
      /^Labels\."io\.cloudgate\.x": refused - .*io\.cloudgate/,
    );
    expect(formatDockerRefusal(order)).toMatch(
      /^UpdateConfig\.Order "start-first": refused - .*stop-first/,
    );
  });

  it('puts a prefix before the path, for the file’s own spelling', () => {
    const [label] = dockerLockRefusals(
      { Labels: { 'traefik.enable': 'true' } },
      'application',
    );

    expect(formatDockerRefusal(label, 'native.docker.')).toMatch(
      /^native\.docker\.Labels\."traefik\.enable": refused - /,
    );
  });
});

/**
 * One list, two readers: every namespace in the list is refused by the
 * console's save and by the deploy, so a namespace added to it reaches both and
 * neither carries a copy of its own.
 */
describe('REFUSED_LABEL_NAMESPACES', () => {
  const keys = [
    'traefik.enable',
    'com.docker.stack.namespace',
    'io.cloudgate.x',
  ];

  it('holds the three namespaces', () => {
    expect(REFUSED_LABEL_NAMESPACES).toHaveLength(3);
    for (const key of keys) {
      expect(
        REFUSED_LABEL_NAMESPACES.filter(({ pattern }) => pattern.test(key)),
      ).toHaveLength(1);
    }
  });

  it.each(keys)('is read by the console’s save: %s', (key) => {
    expect(labelsSwarmSchema.safeParse({ [key]: 'v' }).success).toBe(false);
  });

  it.each(keys)('is read by an Application’s deploy: %s', (key) => {
    expect(() =>
      generateConfigContainer(makeApp({ labelsSwarm: { [key]: 'v' } })),
    ).toThrow(key);
  });

  it.each(keys)('is read by a database’s deploy: %s', (key) => {
    expect(() =>
      buildDatabaseServiceSpec(
        {
          ...makeApp({ labelsSwarm: { [key]: 'v' } }),
          appName: 'db',
          dockerImage: 'postgres:16',
          command: null,
          args: null,
          externalPort: null,
          serverId: null,
        },
        { env: [], targetPort: 5432 },
      ),
    ).toThrow(key);
  });
});
