import type Docker from 'dockerode';
import {
  buildRunJobSettings,
  generateConfigContainer,
  mechanizeDockerContainer,
} from '../../src/deployment-engine/mechanize';
import {
  nativeDockerColumns,
  openDockerColumns,
} from '../../src/native/docker-native';
import { makeApp } from './application.fixture';

const makeDocker = ({
  existing = false,
  liveMode,
}: { existing?: boolean; liveMode?: Record<string, unknown> } = {}) => {
  const inspect = jest.fn<Promise<unknown>, []>();
  if (existing) {
    inspect.mockResolvedValue({
      Version: { Index: '41' },
      Spec: {
        TaskTemplate: { ForceUpdate: 3 },
        ...(liveMode && { Mode: liveMode }),
      },
    });
  } else {
    inspect.mockRejectedValue(new Error('no such service'));
  }
  const service = {
    inspect,
    update: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue(undefined),
    remove: jest.fn<Promise<unknown>, []>().mockResolvedValue(undefined),
  };
  const docker = {
    getService: jest.fn(() => service),
    createService: jest
      .fn<Promise<unknown>, unknown[]>()
      .mockResolvedValue(undefined),
  };
  return { docker: docker as unknown as Docker, raw: docker, service };
};

describe('mechanizeDockerContainer', () => {
  it('creates the swarm service with the expected spec when none exists', async () => {
    const { docker, raw, service } = makeDocker();
    const app = makeApp({
      env: 'PORT=3000',
      replicas: 2,
      memoryLimit: '268435456',
      cpuLimit: '1000000000',
    });

    await mechanizeDockerContainer(app, docker);

    expect(service.update).not.toHaveBeenCalled();
    expect(raw.createService).toHaveBeenCalledTimes(1);
    expect(raw.createService).toHaveBeenCalledWith({
      Name: 'shop-api-x1',
      TaskTemplate: {
        ContainerSpec: {
          Image: 'shop-api-x1:latest',
          Env: ['PORT=3000', 'NVIDIA_VISIBLE_DEVICES=void'],
          Mounts: [],
        },
        Networks: [{ Target: 'cloudgate-network' }],
        Placement: { Constraints: [] },
        Resources: {
          Limits: { MemoryBytes: 268435456, NanoCPUs: 1000000000 },
          Reservations: {},
        },
        // An Application ran on the stock json-file driver with no
        // max-size and no max-file, so one logging in a loop filled the
        // Server's disk and took every other workload on it down with it.
        LogDriver: {
          Name: 'json-file',
          Options: { 'max-size': '10m', 'max-file': '3' },
        },
      },
      Mode: { Replicated: { Replicas: 2 } },
      RollbackConfig: { Parallelism: 1, Order: 'start-first' },
      UpdateConfig: {
        Parallelism: 1,
        Order: 'start-first',
        FailureAction: 'rollback',
      },
    });
  });

  it('updates the existing service in place, bumping ForceUpdate so tasks restart', async () => {
    const { docker, raw, service } = makeDocker({ existing: true });

    await mechanizeDockerContainer(makeApp(), docker);

    expect(raw.createService).not.toHaveBeenCalled();
    expect(service.update).toHaveBeenCalledTimes(1);
    const settings = service.update.mock.calls[0][0] as {
      version: number;
      Name: string;
      TaskTemplate: { ForceUpdate: number };
    };
    expect(settings.version).toBe(41);
    expect(settings.TaskTemplate.ForceUpdate).toBe(4);
    expect(settings.Name).toBe('shop-api-x1');
  });

  /**
   * H-56, held at the emitter as well as the DTO. A `labelsSwarm` row stored
   * before the DTO rule — or re-emitted by a `.partial()` PATCH that omits the
   * field — must not reach the Docker service spec with a `traefik.*` key: the
   * default install's `providers.docker` reads it as a router that hijacks
   * another tenant's domain. The deploy fails before any Docker call, so
   * nothing is created carrying the label.
   */
  it('refuses to converge a service whose stored labels are in the traefik namespace', async () => {
    const { docker, raw, service } = makeDocker();
    const app = makeApp({
      labelsSwarm: {
        'traefik.http.routers.hijack.rule': 'Host(`victim.example.com`)',
      },
    });

    await expect(mechanizeDockerContainer(app, docker)).rejects.toThrow(
      /traefik/i,
    );
    // Nothing was created on the way to being refused.
    expect(raw.createService).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
  });

  /**
   * H-82, at the emitter for H-56's reason: `updateApplicationSchema` is
   * `.partial()`, so a `labelsSwarm` row stored before the DTO rule existed is
   * re-emitted verbatim by any PATCH that omits the field. The DTO alone would
   * leave every already-stored ownership label in place.
   *
   * `com.docker.compose.project` is the key used here because it is the one an
   * ordinary swarm deploy leaves *unoccupied* — swarm writes its own
   * `com.docker.swarm.service.name`, but nothing writes the compose key on a
   * swarm service, so a caller's value lands on the container unopposed and is
   * exactly what `docker ps --format '{{.Label "com.docker.compose.project"}}'`
   * reads back.
   */
  it("refuses to converge a service whose stored labels are in docker's own namespace", async () => {
    const { docker, raw, service } = makeDocker();
    const app = makeApp({
      labelsSwarm: { 'com.docker.compose.project': 'someone-elses | app' },
    });

    await expect(mechanizeDockerContainer(app, docker)).rejects.toThrow(
      /com\.docker/i,
    );
    // Nothing was created on the way to being refused.
    expect(raw.createService).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
  });

  /**
   * `io.cloudgate.*` is reserved for Cloudgate's own marks, and the
   * deploy reads the same lock list the console's save does, so a stored row
   * from before the reservation fails its Deployment naming the key.
   */
  it('refuses to converge a service whose stored labels are in the reserved io.cloudgate namespace', async () => {
    const { docker, raw, service } = makeDocker();
    const app = makeApp({
      labelsSwarm: { 'io.cloudgate.environment': 'forged', team: 'payments' },
    });

    await expect(mechanizeDockerContainer(app, docker)).rejects.toThrow(
      'Labels."io.cloudgate.environment": refused - ',
    );
    // Nothing was created on the way to being refused.
    expect(raw.createService).not.toHaveBeenCalled();
    expect(service.update).not.toHaveBeenCalled();
  });

  /**
   * A stored restart condition, order or failure action outside
   * Docker's documented lists fails the Deployment naming the value, rather
   * than reaching the daemon or being replaced by a default.
   */
  it.each([
    [
      { restartPolicySwarm: { Condition: 'always' } },
      'RestartPolicy.Condition "always"',
    ],
    [
      { updateConfigSwarm: { Parallelism: 1, Order: 'blue-green' } },
      'UpdateConfig.Order "blue-green"',
    ],
    [
      {
        rollbackConfigSwarm: {
          Parallelism: 1,
          Order: 'start-first',
          FailureAction: 'retry',
        },
      },
      'RollbackConfig.FailureAction "retry"',
    ],
  ])(
    'refuses to converge a stored value outside Docker’s lists: %j',
    async (stored, named) => {
      const { docker, raw, service } = makeDocker();

      await expect(
        mechanizeDockerContainer(makeApp(stored as never), docker),
      ).rejects.toThrow(`${named}: refused - `);
      expect(raw.createService).not.toHaveBeenCalled();
      expect(service.update).not.toHaveBeenCalled();
    },
  );

  it('converges an Application whose stored order is start-first', async () => {
    const { docker, raw } = makeDocker();

    await mechanizeDockerContainer(
      makeApp({ updateConfigSwarm: { Parallelism: 1, Order: 'start-first' } }),
      docker,
    );

    expect(raw.createService).toHaveBeenCalled();
  });

  it('converges a service whose stored labels are ordinary', async () => {
    const { docker, raw } = makeDocker();
    const app = makeApp({
      labelsSwarm: { 'com.example.team': 'payments' },
    });

    await mechanizeDockerContainer(app, docker);

    const [settings] = raw.createService.mock.calls[0] as [
      { TaskTemplate: { ContainerSpec: { Labels?: Record<string, string> } } },
    ];
    expect(settings.TaskTemplate.ContainerSpec.Labels).toEqual({
      'com.example.team': 'payments',
    });
  });

  it('runs a docker-sourced app from its image with the registry pull credentials', async () => {
    const { docker, raw } = makeDocker();
    const app = makeApp({
      sourceType: 'docker',
      dockerImage: 'registry.acme.dev/shop/web:1.4',
      username: 'puller',
      password: 'pull-secret',
      registryUrl: 'registry.acme.dev',
      github: null,
    });

    await mechanizeDockerContainer(app, docker);

    const [auth, settings] = raw.createService.mock.calls[0] as [
      { username: string; password: string; serveraddress: string },
      {
        authconfig: object;
        TaskTemplate: { ContainerSpec: { Image: string } };
      },
    ];
    expect(auth).toEqual({
      username: 'puller',
      password: 'pull-secret',
      serveraddress: 'registry.acme.dev',
    });
    expect(settings.TaskTemplate.ContainerSpec.Image).toBe(
      'registry.acme.dev/shop/web:1.4',
    );
  });

  it('runs a registry-linked app from the pushed registry tag with the registry credentials', async () => {
    const { docker, raw } = makeDocker();
    const app = makeApp({
      registry: {
        registryId: 'reg-1',
        name: 'acme registry',
        imagePrefix: null,
        username: 'pusher',
        password: 'reg-secret',
        url: 'registry.acme.dev',
        registryType: 'cloud',
        createdAt: '2026-01-01T00:00:00.000Z',
        organizationId: 'org-1',
      },
    });

    await mechanizeDockerContainer(app, docker);

    const [auth, settings] = raw.createService.mock.calls[0] as [
      { username: string; password: string; serveraddress: string },
      { TaskTemplate: { ContainerSpec: { Image: string } } },
    ];
    expect(auth).toEqual({
      username: 'pusher',
      password: 'reg-secret',
      serveraddress: 'registry.acme.dev',
    });
    expect(settings.TaskTemplate.ContainerSpec.Image).toBe(
      'registry.acme.dev/pusher/shop-api-x1:latest',
    );
  });

  /**
   * The first out-of-scope finding of the rollback work. `resolveAuthConfig` ran
   * unconditionally, so a converge pinned to `options.image` — a rollback tag,
   * the only kind of pinned image there is — shipped the Application's live
   * private-registry credential beside an `Image` that is a **bare** tag. A
   * bare tag is `docker.io/library/<appName>` once the daemon normalizes it, and
   * the blob is what the Swarm Service pulls with, so the operator's registry
   * password was offered to Docker Hub.
   *
   * A credential naming nobody, sent rather than omitted, because the daemon
   * keeps the last one it was given: an update request carrying no
   * `X-Registry-Auth` copies the Service's stored pull credential forward, so
   * an omission would leave the previous Deployment's credential offered
   * against the same Docker Hub pull. The two assertions below are therefore
   * *both* the fix — the blob is present, and it is empty.
   */
  const pinnedApp = () =>
    makeApp({
      sourceType: 'docker',
      dockerImage: 'registry.acme.dev/shop/web:1.4',
      username: 'puller',
      password: 'pull-secret',
      registryUrl: 'registry.acme.dev',
      github: null,
    });

  it('creates a service pinned to a rollback tag with a pull credential naming nobody, not the application’s own', async () => {
    const { docker, raw } = makeDocker();

    await mechanizeDockerContainer(pinnedApp(), docker, {
      image: 'shop-api-x1:v7',
    });

    const [auth, settings] = raw.createService.mock.calls[0] as [
      { username: string; password: string; serveraddress: string },
      { TaskTemplate: { ContainerSpec: { Image: string } } },
    ];
    expect(auth).toEqual({ username: '', password: '', serveraddress: '' });
    // Not merely "no password": the host is what decides which registry the
    // pull is aimed at, and the username is a name of the operator's.
    expect(JSON.stringify(raw.createService.mock.calls[0])).not.toContain(
      'pull-secret',
    );
    expect(JSON.stringify(raw.createService.mock.calls[0])).not.toContain(
      'puller',
    );
    expect(settings.TaskTemplate.ContainerSpec.Image).toBe('shop-api-x1:v7');
  });

  it('updates a service onto a rollback tag with an empty pull credential rather than none, so the stored one is replaced', async () => {
    const { docker, service } = makeDocker({ existing: true });

    await mechanizeDockerContainer(pinnedApp(), docker, {
      image: 'shop-api-x1:v7',
    });

    const settings = service.update.mock.calls[0][0] as {
      authconfig?: unknown;
      TaskTemplate: { ContainerSpec: { Image: string } };
    };
    expect(settings.authconfig).toEqual({
      username: '',
      password: '',
      serveraddress: '',
    });
    expect(settings.TaskTemplate.ContainerSpec.Image).toBe('shop-api-x1:v7');
  });

  it('carries no linked registry’s credential either when the converge is pinned to a rollback tag', async () => {
    const { docker, raw } = makeDocker();
    const app = makeApp({
      registry: {
        registryId: 'reg-1',
        name: 'acme registry',
        imagePrefix: null,
        username: 'pusher',
        password: 'reg-secret',
        url: 'registry.acme.dev',
        registryType: 'cloud',
        createdAt: '2026-01-01T00:00:00.000Z',
        organizationId: 'org-1',
      },
    });

    await mechanizeDockerContainer(app, docker, { image: 'shop-api-x1:v7' });

    const [auth] = raw.createService.mock.calls[0] as [
      { username: string; password: string; serveraddress: string },
    ];
    expect(auth).toEqual({ username: '', password: '', serveraddress: '' });
    expect(JSON.stringify(raw.createService.mock.calls[0])).not.toContain(
      'reg-secret',
    );
  });
  /**
   * **A saved update config does not turn the safety default off**.
   *
   * `updateConfigSwarmSchema` requires `Parallelism` and `Order`, so those two
   * are what an operator who only wanted a `Delay` ends up storing — and the
   * whole block used to replace Cloudgate's, so the `FailureAction` they never
   * touched became Docker's `pause`. A release that never converged then sat
   * half-updated instead of rolling back, and the "Swarm rolled it back"
   * outcome could not happen. Measured on the live host in the
   * ticket: `FailureAction` went from `rollback` to `pause` after an edit that
   * set Parallelism, Order and Delay.
   */
  it('deploys the rollback failure action under an update config that omits it', async () => {
    const { docker, raw } = makeDocker();
    const app = makeApp({
      updateConfigSwarm: { Parallelism: 1, Order: 'start-first' },
    });

    await mechanizeDockerContainer(app, docker);

    const [settings] = raw.createService.mock.calls[0] as [
      { UpdateConfig: Record<string, unknown> },
    ];
    expect(settings.UpdateConfig).toEqual({
      Parallelism: 1,
      Order: 'start-first',
      FailureAction: 'rollback',
    });
  });

  it('keeps the operator’s own failure action and delay', async () => {
    const { docker, raw } = makeDocker();
    const app = makeApp({
      updateConfigSwarm: {
        Parallelism: 3,
        Order: 'stop-first',
        FailureAction: 'continue',
        Delay: 10_000_000_000,
      },
    });

    await mechanizeDockerContainer(app, docker);

    const [settings] = raw.createService.mock.calls[0] as [
      { UpdateConfig: Record<string, unknown> },
    ];
    expect(settings.UpdateConfig).toEqual({
      Parallelism: 3,
      Order: 'stop-first',
      FailureAction: 'continue',
      Delay: 10_000_000_000,
    });
  });

  /**
   * The same shape, twice more in the same function. A rollback config keeps
   * the `Order` Cloudgate deploys, and a placement that names no constraints
   * keeps the one a mounted service cannot schedule without.
   */
  it('deploys the default order under a rollback config that does not carry one', async () => {
    const { docker, raw } = makeDocker();
    const app = makeApp({
      // `updateConfigSwarmSchema` makes `Order` required, so this is not a body
      // the API takes: it is the in-process shape the `undefined` filter in
      // `over` is for — a key `JSON.stringify` would drop on the way to the
      // daemon, leaving Docker to choose.
      rollbackConfigSwarm: { Parallelism: 2, Order: undefined } as never,
    });

    await mechanizeDockerContainer(app, docker);

    const [settings] = raw.createService.mock.calls[0] as [
      { RollbackConfig: Record<string, unknown> },
    ];
    expect(settings.RollbackConfig).toEqual({
      Parallelism: 2,
      Order: 'start-first',
    });
  });

  it('keeps a mounted service on the manager under a placement that names no constraints', async () => {
    const { docker, raw } = makeDocker();
    const app = makeApp({
      mounts: [
        {
          mountId: 'm1',
          type: 'volume',
          volumeName: 'shop-uploads',
          hostPath: null,
          filePath: null,
          content: null,
          mountPath: '/data',
          serviceType: 'application',
          applicationId: 'app-1',
          composeId: null,
        },
      ] as never,
      placementSwarm: { MaxReplicas: 5 },
    });

    await mechanizeDockerContainer(app, docker);

    const [settings] = raw.createService.mock.calls[0] as [
      { TaskTemplate: { Placement: Record<string, unknown> } },
    ];
    expect(settings.TaskTemplate.Placement).toEqual({
      Constraints: ['node.role==manager'],
      MaxReplicas: 5,
    });
  });

  it('lets a placement that names constraints replace the default one', async () => {
    const { docker, raw } = makeDocker();
    const app = makeApp({
      mounts: [
        {
          mountId: 'm1',
          type: 'volume',
          volumeName: 'shop-uploads',
          hostPath: null,
          filePath: null,
          content: null,
          mountPath: '/data',
          serviceType: 'application',
          applicationId: 'app-1',
          composeId: null,
        },
      ] as never,
      placementSwarm: { Constraints: ['node.labels.storage==ssd'] },
    });

    await mechanizeDockerContainer(app, docker);

    const [settings] = raw.createService.mock.calls[0] as [
      { TaskTemplate: { Placement: Record<string, unknown> } },
    ];
    expect(settings.TaskTemplate.Placement).toEqual({
      Constraints: ['node.labels.storage==ssd'],
    });
  });

  // An Application that reserves no GPU is kept off every card, so it
  // cannot use one another Application reserved. The value is the platform's:
  // an operator's own assignment of either name does not reach the spec.
  describe('native.docker over the kind’s defaults', () => {
    it('carries a web’s native health check, and one update field over Cloudgate’s others', async () => {
      const { docker, raw } = makeDocker();
      const app = makeApp(
        nativeDockerColumns('web', {
          HealthCheck: { Test: ['CMD', 'true'], Retries: 5 },
          UpdateConfig: { Delay: 5_000_000_000 },
        }),
      );

      await mechanizeDockerContainer(app, docker);

      const [settings] = raw.createService.mock.calls[0] as [
        {
          TaskTemplate: { ContainerSpec: { HealthCheck?: unknown } };
          UpdateConfig: unknown;
          RollbackConfig: unknown;
        },
      ];
      expect(settings.TaskTemplate.ContainerSpec.HealthCheck).toEqual({
        Test: ['CMD', 'true'],
        Retries: 5,
      });
      expect(settings.UpdateConfig).toEqual({
        Parallelism: 1,
        Order: 'start-first',
        FailureAction: 'rollback',
        Delay: 5_000_000_000,
      });
      expect(settings.RollbackConfig).toEqual({
        Parallelism: 1,
        Order: 'start-first',
      });
    });

    it('lays a stored health check and restart policy over nothing rather than passing undefined fields', () => {
      const spec = generateConfigContainer(
        makeApp({
          healthCheckSwarm: { Retries: 2, Interval: undefined },
          restartPolicySwarm: { Condition: 'on-failure', Delay: undefined },
        }),
      );
      expect(Object.keys(spec.HealthCheck ?? {})).toEqual(['Retries']);
      expect(Object.keys(spec.RestartPolicy ?? {})).toEqual(['Condition']);
    });

    it('fails the Deployment naming the native path when Docker refuses a value only it can judge', async () => {
      const { docker, raw } = makeDocker();
      raw.createService.mockRejectedValue(
        new Error('invalid ulimit type: nofiles'),
      );
      const app = makeApp(
        nativeDockerColumns('web', {
          Ulimits: [{ Name: 'nofiles', Soft: 1024, Hard: 1024 }],
        }),
      );

      await expect(mechanizeDockerContainer(app, docker)).rejects.toThrow(
        "Docker refused this Service's native.docker.Ulimits: invalid ulimit type: nofiles",
      );
    });
  });

  describe('keeping an unreserved Application off the GPUs', () => {
    const createdEnv = async (app: ReturnType<typeof makeApp>) => {
      const { docker, raw } = makeDocker();
      await mechanizeDockerContainer(app, docker);
      const [settings] = raw.createService.mock.calls[0] as [
        { TaskTemplate: { ContainerSpec: { Env: string[] } } },
      ];
      return settings.TaskTemplate.ContainerSpec.Env;
    };

    it('hides the cards from an Application reserving none', async () => {
      const env = await createdEnv(makeApp({ gpus: 0, env: 'PORT=3000' }));

      expect(env).toEqual(['PORT=3000', 'NVIDIA_VISIBLE_DEVICES=void']);
    });

    it('does not hide them from an Application reserving one', async () => {
      const env = await createdEnv(makeApp({ gpus: 1, env: 'PORT=3000' }));

      expect(env).toEqual(['PORT=3000']);
    });

    it('keeps the platform value over an operator assignment of either name', async () => {
      const env = await createdEnv(
        makeApp({
          gpus: 0,
          env: 'NVIDIA_VISIBLE_DEVICES=all\nCUDA_VISIBLE_DEVICES=0\nPORT=3000',
        }),
      );

      expect(env).toEqual(['PORT=3000', 'NVIDIA_VISIBLE_DEVICES=void']);
    });

    it('keeps it over one inherited from the Project or the Environment', async () => {
      const base = makeApp();
      const env = await createdEnv(
        makeApp({
          gpus: 0,
          env: 'PORT=3000',
          environment: {
            ...base.environment,
            env: 'NVIDIA_VISIBLE_DEVICES=0',
            project: {
              ...base.environment.project,
              env: 'NVIDIA_VISIBLE_DEVICES=all',
            },
          },
        }),
      );

      expect(env).toEqual(['PORT=3000', 'NVIDIA_VISIBLE_DEVICES=void']);
    });
  });

  /**
   * Swarm refuses to change a service's mode in place — the update
   * answers `service mode change is not allowed` — so a saved mode that differs
   * from the live one used to fail every Deployment at release, after the
   * build, until it was set back. The service is recreated instead, and the
   * outcome says so, so the Update phase's line reads "recreated".
   */
  describe('a mode change on a deployed service', () => {
    it('recreates a replicated service as global rather than updating it', async () => {
      const { docker, raw, service } = makeDocker({
        existing: true,
        liveMode: { Replicated: { Replicas: 1 } },
      });

      const outcome = await mechanizeDockerContainer(
        makeApp({ modeSwarm: { Global: {} } }),
        docker,
      );

      expect(outcome).toBe('recreated');
      expect(service.update).not.toHaveBeenCalled();
      expect(service.remove).toHaveBeenCalledTimes(1);
      expect(raw.createService).toHaveBeenCalledTimes(1);
      const [settings] = raw.createService.mock.calls[0] as [
        { Name: string; Mode: unknown; TaskTemplate: Record<string, unknown> },
      ];
      expect(settings.Name).toBe('shop-api-x1');
      expect(settings.Mode).toEqual({ Global: {} });
      // A fresh service has no ForceUpdate counter to carry forward.
      expect(settings.TaskTemplate).not.toHaveProperty('ForceUpdate');
      expect(service.remove.mock.invocationCallOrder[0]).toBeLessThan(
        raw.createService.mock.invocationCallOrder[0],
      );
    });

    it('recreates a global service when the mode is cleared back to replicated', async () => {
      const { docker, raw, service } = makeDocker({
        existing: true,
        liveMode: { Global: {} },
      });

      const outcome = await mechanizeDockerContainer(
        makeApp({ modeSwarm: null, replicas: 2 }),
        docker,
      );

      expect(outcome).toBe('recreated');
      expect(service.remove).toHaveBeenCalledTimes(1);
      const [settings] = raw.createService.mock.calls[0] as [{ Mode: unknown }];
      expect(settings.Mode).toEqual({ Replicated: { Replicas: 2 } });
    });

    it('still updates in place when only the replica count changes', async () => {
      const { docker, raw, service } = makeDocker({
        existing: true,
        liveMode: { Replicated: { Replicas: 1 } },
      });

      const outcome = await mechanizeDockerContainer(
        makeApp({ modeSwarm: { Replicated: { Replicas: 3 } } }),
        docker,
      );

      expect(outcome).toBe('updated');
      expect(service.remove).not.toHaveBeenCalled();
      expect(raw.createService).not.toHaveBeenCalled();
      expect(service.update).toHaveBeenCalledTimes(1);
    });

    it('logs that the service is removed and created again before removing it', async () => {
      const { docker, service } = makeDocker({
        existing: true,
        liveMode: { Replicated: { Replicas: 1 } },
      });
      const log = jest.fn<Promise<void>, [string]>().mockResolvedValue();

      await mechanizeDockerContainer(
        makeApp({ modeSwarm: { Global: {} } }),
        docker,
        { log },
      );

      expect(log).toHaveBeenCalledTimes(1);
      const [line] = log.mock.calls[0];
      expect(line).toContain('Service mode changed from Replicated to Global');
      expect(line).toMatch(/cannot change it in place/);
      expect(line).toMatch(/removed and created again/);
      expect(log.mock.invocationCallOrder[0]).toBeLessThan(
        service.remove.mock.invocationCallOrder[0],
      );
    });

    it('says the Application is offline when creating the removed service again fails', async () => {
      const { docker, raw } = makeDocker({
        existing: true,
        liveMode: { Replicated: { Replicas: 1 } },
      });
      raw.createService.mockRejectedValue(
        new Error('(HTTP code 400) bad parameter - invalid mount config'),
      );

      const failure = mechanizeDockerContainer(
        makeApp({ modeSwarm: { Global: {} } }),
        docker,
      );

      await expect(failure).rejects.toThrow(
        /was removed because its mode changed from Replicated to Global, and creating it again failed, so the Application is offline/,
      );
      await expect(failure).rejects.toThrow(/invalid mount config/);
    });

    it('says the service is still running as it was when the removal itself fails', async () => {
      const { docker, raw, service } = makeDocker({
        existing: true,
        liveMode: { Global: {} },
      });
      service.remove.mockRejectedValue(new Error('rpc error: timeout'));

      const failure = mechanizeDockerContainer(makeApp(), docker);

      await expect(failure).rejects.toThrow(
        /could not be removed .*still running as it was before this Deployment: rpc error: timeout/,
      );
      expect(raw.createService).not.toHaveBeenCalled();
    });

    it('carries the pull credential onto the recreated service', async () => {
      const { docker, raw } = makeDocker({
        existing: true,
        liveMode: { Replicated: { Replicas: 1 } },
      });

      await mechanizeDockerContainer(
        makeApp({
          sourceType: 'docker',
          dockerImage: 'registry.example/shop:1',
          username: 'bot',
          password: 's3cret',
          registryUrl: 'registry.example',
          modeSwarm: { Global: {} },
        }),
        docker,
      );

      expect(raw.createService.mock.calls[0][0]).toEqual({
        username: 'bot',
        password: 's3cret',
        serveraddress: 'registry.example',
      });
    });
  });

  /**
   * The Networks card promises networks "beyond the default one", but a
   * stored list replaced `cloudgate-network` — the only network Traefik is on —
   * so every domain answered 502 while the Deployment reported ✅.
   */
  describe('operator networks', () => {
    it('attaches the listed networks in addition to cloudgate-network', async () => {
      const { docker, raw } = makeDocker();

      await mechanizeDockerContainer(
        makeApp({ networkSwarm: [{ Target: 'ui-u06-net' }] }),
        docker,
      );

      const [settings] = raw.createService.mock.calls[0] as [
        { TaskTemplate: { Networks: unknown } },
      ];
      expect(settings.TaskTemplate.Networks).toEqual([
        { Target: 'cloudgate-network' },
        { Target: 'ui-u06-net' },
      ]);
    });

    it('keeps the aliases an operator gave the default network, listing it once', () => {
      const { Networks } = generateConfigContainer(
        makeApp({
          networkSwarm: [
            { Target: 'internal-db', Aliases: ['db'] },
            { Target: 'cloudgate-network', Aliases: ['shop'] },
            { Target: 'internal-db' },
          ],
        }),
      );

      expect(Networks).toEqual([
        { Target: 'cloudgate-network', Aliases: ['shop'] },
        { Target: 'internal-db', Aliases: ['db'] },
      ]);
    });

    it('attaches cloudgate-network under an empty stored list', () => {
      const { Networks } = generateConfigContainer(
        makeApp({ networkSwarm: [] }),
      );

      expect(Networks).toEqual([{ Target: 'cloudgate-network' }]);
    });

    /**
     * At the emitter, for H-56's reason: the DTO refuses `cloudgate-ai`
     * on a new write, and this refuses a row stored before the rule existed.
     */
    it('refuses to converge a service whose stored networks name cloudgate-ai', async () => {
      const { docker, raw, service } = makeDocker();
      const app = makeApp({ networkSwarm: [{ Target: 'cloudgate-ai' }] });

      await expect(mechanizeDockerContainer(app, docker)).rejects.toThrow(
        /"cloudgate-ai" is the AI models' own network/,
      );
      expect(raw.createService).not.toHaveBeenCalled();
      expect(service.update).not.toHaveBeenCalled();
    });
  });

  describe('a GPU reservation', () => {
    type Spec = {
      TaskTemplate: { Resources: { Reservations: Record<string, unknown> } };
      UpdateConfig: Record<string, unknown>;
      RollbackConfig: Record<string, unknown>;
    };
    const created = (raw: { createService: jest.Mock }) =>
      (raw.createService.mock.calls[0] as [Spec])[0];

    it('reserves N GPUs per copy as a generic resource, naming no card', async () => {
      const { docker, raw } = makeDocker();

      await mechanizeDockerContainer(makeApp({ gpus: 2 }), docker);

      expect(created(raw).TaskTemplate.Resources.Reservations).toEqual({
        GenericResources: [{ DiscreteResourceSpec: { Kind: 'GPU', Value: 2 } }],
      });
    });

    it('reserves no generic resource for an Application with no GPUs', async () => {
      const { docker, raw } = makeDocker();

      await mechanizeDockerContainer(makeApp({ gpus: 0 }), docker);

      expect(
        created(raw).TaskTemplate.Resources.Reservations,
      ).not.toHaveProperty('GenericResources');
    });

    it('updates and rolls back stop-first over a stored start-first', async () => {
      const { docker, raw } = makeDocker();
      const app = makeApp({
        gpus: 1,
        updateConfigSwarm: { Parallelism: 2, Order: 'start-first' },
        rollbackConfigSwarm: { Parallelism: 2, Order: 'start-first' },
      });

      await mechanizeDockerContainer(app, docker);

      expect(created(raw).UpdateConfig).toEqual({
        Parallelism: 2,
        Order: 'stop-first',
        FailureAction: 'rollback',
      });
      expect(created(raw).RollbackConfig).toEqual({
        Parallelism: 2,
        Order: 'stop-first',
      });
    });

    it('keeps the start-first default for an Application with no GPUs', () => {
      const spec = generateConfigContainer(makeApp({ gpus: 0 }));

      expect(spec.UpdateConfig.Order).toBe('start-first');
      expect(spec.RollbackConfig.Order).toBe('start-first');
    });
  });
});

describe('buildRunJobSettings — a cron’s native.docker', () => {
  const run = (app: ReturnType<typeof makeApp>) =>
    buildRunJobSettings(app, { name: 'job-run-1', image: 'job:abc' });

  it('carries the labels, stop grace and ulimits Apply wrote onto the run’s job, the rest of the run Cloudgate’s', () => {
    const job = run(
      makeApp(
        openDockerColumns('cron', {
          Labels: { 'com.example.team': 'billing' },
          StopGracePeriod: 20_000_000_000,
          Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 2048 }],
        }),
      ),
    );
    const task = job.TaskTemplate as {
      ContainerSpec: Record<string, unknown>;
      RestartPolicy: unknown;
    };

    expect(task.ContainerSpec).toEqual(
      expect.objectContaining({
        Labels: { 'com.example.team': 'billing' },
        StopGracePeriod: 20_000_000_000,
        Ulimits: [{ Name: 'nofile', Soft: 1024, Hard: 2048 }],
      }),
    );
    expect(task.ContainerSpec.HealthCheck).toBeUndefined();
    expect(task.RestartPolicy).toEqual({ Condition: 'none' });
    expect(job.Mode).toEqual({
      ReplicatedJob: { MaxConcurrent: 1, TotalCompletions: 1 },
    });
    expect(job).not.toHaveProperty('UpdateConfig');
    expect(job).not.toHaveProperty('RollbackConfig');
  });

  it('runs with Docker’s stop grace, no labels and no ulimits when the block is taken out', () => {
    const task = run(makeApp(openDockerColumns('cron', undefined)))
      .TaskTemplate as { ContainerSpec: Record<string, unknown> };
    expect(task.ContainerSpec.Labels).toBeUndefined();
    expect(task.ContainerSpec.StopGracePeriod).toBeUndefined();
    expect(task.ContainerSpec.Ulimits).toBeUndefined();
  });

  it.each([
    [
      'HealthCheck',
      { healthCheckSwarm: { Test: ['CMD', 'true'] } },
      /exit code/,
    ],
    [
      'RestartPolicy',
      { restartPolicySwarm: { Condition: 'any' as const } },
      /never retried/,
    ],
    [
      'UpdateConfig',
      { updateConfigSwarm: { Parallelism: 1, Order: 'start-first' as const } },
      /no copies to update/,
    ],
    [
      'RollbackConfig',
      {
        rollbackConfigSwarm: { Parallelism: 1, Order: 'start-first' as const },
      },
      /nothing to roll back/,
    ],
  ])(
    'fails a run from a stored row that still holds a %s, naming it',
    (key, columns, reason) => {
      expect(() => run(makeApp(columns))).toThrow(
        new RegExp(`${key} \\{.*\\}: refused - `),
      );
      expect(() => run(makeApp(columns))).toThrow(reason);
    },
  );
});
