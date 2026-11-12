import { buildDatabaseServiceSpec } from '../../src/databases/common/database-spec';
import type { DatabaseSpecSource } from '../../src/databases/common/database-spec';
import { nativeDockerColumns } from '../../src/native/docker-native';

/**
 * `buildDatabaseServiceSpec` is pure spec generation shared by all six engines
 * (`buildPostgres`/`buildMysql`/…), so the object it returns is the thing to
 * assert on. Every database in the console goes through this one function, which
 * is why one assertion here covers all of them.
 */
const makeDatabase = (
  overrides: Partial<DatabaseSpecSource> = {},
): DatabaseSpecSource => ({
  appName: 'shop-db-x1',
  dockerImage: 'postgres:16',
  command: null,
  args: null,
  externalPort: null,
  // The run Server, and a managed database's only machine: an earlier fix put it on the
  // source type because the file-mount bind sources in the spec are resolved by
  // the daemon on it. `null` here is the platform host (ADR-0008), which is
  // what every assertion in this file is about.
  serverId: null,
  replicas: 1,
  memoryLimit: null,
  memoryReservation: null,
  cpuLimit: null,
  cpuReservation: null,
  healthCheckSwarm: null,
  restartPolicySwarm: null,
  placementSwarm: null,
  updateConfigSwarm: null,
  rollbackConfigSwarm: null,
  modeSwarm: null,
  labelsSwarm: null,
  networkSwarm: null,
  stopGracePeriodSwarm: null,
  endpointSpecSwarm: null,
  ulimitsSwarm: null,
  mounts: [],
  ports: [],
  ...overrides,
});

describe('buildDatabaseServiceSpec', () => {
  // Nothing in the tree set a LogConfig or a LogDriver, so a managed
  // database ran on the daemon's stock json-file driver with no max-size and no
  // max-file. It is the container most likely to log in a loop — an application
  // retrying a bad connection string is one refused authentication per attempt,
  // written here — and the disk it fills is the platform host's.
  it('bounds a database’s log the way an Application’s is bounded', () => {
    const spec = buildDatabaseServiceSpec(makeDatabase(), {
      env: ['POSTGRES_PASSWORD=x'],
      targetPort: 5432,
    });

    expect(spec.TaskTemplate?.LogDriver).toEqual({
      Name: 'json-file',
      Options: { 'max-size': '10m', 'max-file': '3' },
    });
  });

  it('keeps the driver stock, so docker service logs still reads it', () => {
    const spec = buildDatabaseServiceSpec(makeDatabase(), {
      env: [],
      targetPort: 3306,
    });

    // A capped log that no ordinary command can read would trade one silence
    // for another; only json-file is what a bare `docker service logs` reads.
    expect(spec.TaskTemplate?.LogDriver?.Name).toBe('json-file');
  });

  // Nothing else about the spec moved: the ceiling is a sibling of Resources,
  // not a replacement for anything the six engines rely on.
  it('leaves the stop-first update policy and the flush grace period alone', () => {
    const spec = buildDatabaseServiceSpec(makeDatabase(), {
      env: [],
      targetPort: 5432,
    });

    // `TaskSpec` is a union with `PluginTaskSpec`, which carries no
    // ContainerSpec, so the narrow has to be explicit.
    const { ContainerSpec } = spec.TaskTemplate as {
      ContainerSpec: { StopGracePeriod?: number };
    };

    expect(spec.UpdateConfig?.Order).toBe('stop-first');
    expect(ContainerSpec.StopGracePeriod).toBe(30_000_000_000);
  });

  // The rollback came from `generateConfigContainer`, whose defaults are
  // an Application's start-first, so a failed database update rolled back with
  // two copies of the database on one volume. A stored update config replaced
  // the stop-first default whole. Both blocks are now laid over the database's
  // own defaults, and the order is stop-first whatever is stored.
  describe('updating and rolling back stop-first', () => {
    const orders = (overrides: Partial<DatabaseSpecSource>) => {
      const spec = buildDatabaseServiceSpec(makeDatabase(overrides), {
        env: [],
        targetPort: 5432,
      });
      return [spec.UpdateConfig?.Order, spec.RollbackConfig?.Order];
    };

    it('updates and rolls back stop-first with nothing stored', () => {
      expect(orders({})).toEqual(['stop-first', 'stop-first']);
    });

    it('keeps stop-first under a stored config that omits the order', () => {
      // The DTO requires `Order`, but a row written past it, or before it, is
      // what the deploy reads.
      const noOrder = {
        Parallelism: 2,
      } as DatabaseSpecSource['updateConfigSwarm'];
      expect(
        orders({ updateConfigSwarm: noOrder, rollbackConfigSwarm: noOrder }),
      ).toEqual(['stop-first', 'stop-first']);
    });

    // A stored start-first used to be forced to stop-first here, so
    // what ran was not what the console showed (ADR-0044 rule 9). It now
    // fails the Deployment, naming the value; nothing is overwritten.
    it.each(['updateConfigSwarm', 'rollbackConfigSwarm'] as const)(
      'refuses a stored start-first in %s, naming it',
      (column) => {
        const block =
          column === 'updateConfigSwarm' ? 'UpdateConfig' : 'RollbackConfig';
        expect(() =>
          orders({ [column]: { Parallelism: 1, Order: 'start-first' } }),
        ).toThrow(`${block}.Order "start-first": refused - `);
      },
    );

    it('refuses a stored order or failure action outside Docker’s lists', () => {
      expect(() =>
        orders({
          updateConfigSwarm: {
            Parallelism: 1,
            Order: 'stop-first',
            FailureAction: 'retry',
          } as never,
        }),
      ).toThrow('UpdateConfig.FailureAction "retry": refused - ');
      expect(() =>
        orders({
          rollbackConfigSwarm: { Parallelism: 1, Order: 'later' } as never,
        }),
      ).toThrow('RollbackConfig.Order "later": refused - ');
    });

    it('lays a stored field over the defaults rather than replacing them', () => {
      const spec = buildDatabaseServiceSpec(
        makeDatabase({
          updateConfigSwarm: { Parallelism: 3, Order: 'stop-first' },
          rollbackConfigSwarm: {
            Parallelism: 2,
            Order: 'stop-first',
            FailureAction: 'pause',
          },
        }),
        { env: [], targetPort: 5432 },
      );

      // The update keeps its `rollback` failure action: a stored block used to
      // stand alone, and deployed with Docker's `pause`.
      expect(spec.UpdateConfig).toEqual({
        Parallelism: 3,
        Order: 'stop-first',
        FailureAction: 'rollback',
      });
      expect(spec.RollbackConfig).toEqual({
        Parallelism: 2,
        Order: 'stop-first',
        FailureAction: 'pause',
      });
    });
  });

  describe('native.docker over a database’s defaults', () => {
    it('keeps stop-first and rollback under a native update that sets one field', () => {
      const spec = buildDatabaseServiceSpec(
        makeDatabase(
          nativeDockerColumns('postgres', { UpdateConfig: { Delay: 7 } }),
        ),
        { env: [], targetPort: 5432 },
      );
      expect(spec.UpdateConfig).toEqual({
        Parallelism: 1,
        Order: 'stop-first',
        FailureAction: 'rollback',
        Delay: 7,
      });
      expect(spec.RollbackConfig).toEqual({
        Parallelism: 1,
        Order: 'stop-first',
      });
    });

    it('gives a database thirty seconds to stop unless its native block says otherwise', () => {
      const grace = (overrides: Partial<DatabaseSpecSource>) => {
        const spec = buildDatabaseServiceSpec(makeDatabase(overrides), {
          env: [],
          targetPort: 5432,
        });
        return (
          spec.TaskTemplate as { ContainerSpec: { StopGracePeriod?: number } }
        ).ContainerSpec.StopGracePeriod;
      };
      expect(grace({})).toBe(30_000_000_000);
      expect(
        grace(nativeDockerColumns('redis', { StopGracePeriod: 5_000_000_000 })),
      ).toBe(5_000_000_000);
    });
  });

  // No database reserves a GPU, so every one is kept off the cards. The
  // six engines share this one builder, which is why one spec covers them.
  describe('keeping a database off the GPUs', () => {
    const engines = [
      ['postgres', 'postgres:16', 5432],
      ['mysql', 'mysql:8', 3306],
      ['mariadb', 'mariadb:11', 3306],
      ['mongo', 'mongo:7', 27017],
      ['redis', 'redis:7', 6379],
      ['libsql', 'ghcr.io/tursodatabase/libsql-server:latest', 8080],
    ] as const;

    it.each(engines)(
      'hides the cards from a %s database',
      (_engine, dockerImage, targetPort) => {
        const spec = buildDatabaseServiceSpec(makeDatabase({ dockerImage }), {
          env: ['A=1'],
          targetPort,
        });

        expect(spec.TaskTemplate).toMatchObject({
          ContainerSpec: { Env: ['A=1', 'NVIDIA_VISIBLE_DEVICES=void'] },
        });
      },
    );

    it('keeps the platform value over an operator assignment of either name', () => {
      const spec = buildDatabaseServiceSpec(makeDatabase(), {
        env: [
          'NVIDIA_VISIBLE_DEVICES=all',
          'CUDA_VISIBLE_DEVICES=0',
          'POSTGRES_PASSWORD=x',
        ],
        targetPort: 5432,
      });

      expect(spec.TaskTemplate).toMatchObject({
        ContainerSpec: {
          Env: ['POSTGRES_PASSWORD=x', 'NVIDIA_VISIBLE_DEVICES=void'],
        },
      });
    });
  });
});
