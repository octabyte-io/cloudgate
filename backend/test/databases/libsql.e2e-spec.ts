import { NotFoundException } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { LibsqlService } from '../../src/databases/libsql/libsql.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { expectQuotedInCommand } from '../utils/shell-safety';
import { createTestApp, TestAppContext } from '../utils/test-app';
/**
 * Whether a command is the presence probe Delete issues. Matched by its
 * three-branch shell shape rather than by the question inside it, and both ends
 * are checked: a `startsWith('docker service inspect ')` discriminator was what
 * H-104 was, because H-95 moved the question behind an `if ! docker version`
 * reachability branch and this file's copy of the discriminator was not
 * updated, so it matched nothing, the probe answered `''`,
 * `readWorkloadPresence` read that as `'unknown'` and the happy-path delete
 * 409'd.
 *
 * Hand-written rather than imported from `database-ops.ts`, and now one copy
 * for the whole test tree rather than this file's own: importing the
 * product's builder would make the test agree with whatever the builder says,
 * and the shell trick this probe turns on — exit 0 either way, the answer on
 * stdout — is exactly what a "simplification" would quietly drop, while ten
 * copies of it bought nothing but nine ways to go stale. The set-level guard
 * that catches the remaining copy going stale is in
 * `test/common/workload-presence.spec.ts`.
 */
import { isPresenceProbe } from '../utils/workload-presence-probe';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

const LIBSQL_IMAGE = 'ghcr.io/tursodatabase/libsql-server:v0.24.32';
const DEFAULT_SQLD_COMMAND =
  'sqld --db-path iku.db --http-listen-addr 0.0.0.0:8080 --grpc-listen-addr 0.0.0.0:5001 --admin-listen-addr 0.0.0.0:5000';

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

async function signUp(
  server: App,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  const res = await request(server).post('/api/auth/sign-up/email').send(body);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
}

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

/**
 * The exec layer as Delete sees it: every command succeeds and the presence
 * read says the swarm service is gone, which is the happy path. A plain
 * `mockResolvedValue({ stdout: '', … })` would leave the probe answering an
 * empty stdout — `'unknown'`, deliberately, because a shell that never ran the
 * command is no more "gone" than a rejection is — and every delete would 409.
 */
const teardownSucceeds = (command: string) =>
  Promise.resolve(
    isPresenceProbe(command)
      ? { stdout: 'absent', stderr: '' }
      : { stdout: '', stderr: '' },
  );

describe('LibSQL (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let libsqlService: LibsqlService;

  const execMock = withArgvExec({
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  });

  /** A Swarm with no existing service: inspect rejects, so a deploy
   * converges by creating the service. */
  const dockerService = {
    inspect: jest.fn(),
    update: jest.fn(),
  };
  const docker = {
    getService: jest.fn(() => dockerService),
    createService: jest.fn(),
    // `docker service ps`: the deploy waits for a running task before it
    // writes `done`, and a created service has one at once here.
    listTasks: jest.fn().mockResolvedValue([{ Status: { State: 'running' } }]),
  };
  const dockerFactoryMock = {
    getRemoteDocker: jest.fn().mockResolvedValue(docker),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: RemoteDockerFactory, useValue: dockerFactoryMock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    libsqlService = ctx.app.get(LibsqlService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    // Delete verifies the swarm service is really gone before it drops the row
    // so the presence read has to answer. Everything else is unchanged.
    execMock.execAsync.mockReset().mockImplementation(teardownSucceeds);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId: string, command: string) =>
        teardownSucceeds(command),
      );
    dockerService.inspect
      .mockReset()
      .mockRejectedValue(new Error('no such service'));
    dockerService.update.mockReset().mockResolvedValue(undefined);
    docker.getService.mockClear();
    docker.createService.mockReset().mockResolvedValue(undefined);
    dockerFactoryMock.getRemoteDocker.mockClear();
  });

  /** An owner session with a production environment to hang databases off. */
  async function setUpEnvironment() {
    const ownerSession = await signUp(server, owner);
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', ownerSession.cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = permissionCtx(ownerSession.id, organizationId);

    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    return {
      organizationId,
      ownerSession,
      ownerCtx,
      environmentId: environment.environmentId,
    };
  }

  /** Creates a database over HTTP as the owner and returns its row. */
  async function createDatabase(
    cookie: string,
    environmentId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const created = await request(server)
      .post('/libsql')
      .set('Cookie', cookie)
      .send({
        name: 'Main DB',
        appName: 'main-db',
        databaseUser: 'libsql_user',
        databasePassword: 'sup3rS3cret',
        environmentId,
        ...overrides,
      });
    expect(created.status).toBe(201);
    return created.body as { libsqlId: string; appName: string };
  }

  describe('create', () => {
    it('creates a libsql database retrievable with its connection info', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();

      const created = await request(server)
        .post('/libsql')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Main DB',
          appName: 'main-db',
          databaseUser: 'libsql_user',
          databasePassword: 'sup3rS3cret',
          environmentId,
        });
      expect(created.status).toBe(201);
      const { libsqlId } = created.body as { libsqlId: string };
      expect(libsqlId).toEqual(expect.any(String));

      const found = await request(server)
        .get(`/libsql/${libsqlId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({
        libsqlId,
        name: 'Main DB',
        appName: 'main-db',
        databaseUser: 'libsql_user',
        databasePassword: 'sup3rS3cret',
        dockerImage: LIBSQL_IMAGE,
        sqldNode: 'primary',
        sqldPrimaryUrl: null,
        enableNamespaces: false,
        applicationStatus: 'idle',
        externalPort: null,
        externalGRPCPort: null,
        externalAdminPort: null,
        environmentId,
      });
    });

    it('a replica requires sqldPrimaryUrl, and a primary must not carry one', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();

      const replicaWithoutUrl = await request(server)
        .post('/libsql')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Replica DB',
          databaseUser: 'libsql_user',
          databasePassword: 'sup3rS3cret',
          sqldNode: 'replica',
          environmentId,
        });
      expect(replicaWithoutUrl.status).toBe(400);

      const primaryWithUrl = await request(server)
        .post('/libsql')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Primary DB',
          databaseUser: 'libsql_user',
          databasePassword: 'sup3rS3cret',
          sqldNode: 'primary',
          sqldPrimaryUrl: 'http://primary-db:5001',
          environmentId,
        });
      expect(primaryWithUrl.status).toBe(400);
    });
  });

  describe('deploy', () => {
    it('creates the service with the sqld entrypoint, SQLD_* env and data volume', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { libsqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const deployed = await request(server)
        .post(`/libsql/${libsqlId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      expect(deployed.status).toBe(200);

      // The image is pulled onto the target server before converging. The
      // `dockerImage` column is quoted on its way into `docker pull`, so
      // the assertion is a `shell-quote` parse of the word the shell would hand
      // the command rather than a substring match on the emitted string.
      const commands = execMock.execAsync.mock.calls.map(
        ([command]: [string]) => command,
      );
      const pull = commands.find((command) =>
        command.startsWith('docker pull'),
      );
      expectQuotedInCommand(pull ?? null, LIBSQL_IMAGE);

      expect(docker.createService).toHaveBeenCalledTimes(1);
      const [settings] = docker.createService.mock.lastCall as [
        {
          Name: string;
          TaskTemplate: {
            ContainerSpec: {
              Image: string;
              Env: string[];
              Mounts: { Type: string; Source: string; Target: string }[];
              Command?: string[];
              Args?: string[];
            };
          };
          EndpointSpec: { Mode: string; Ports: unknown[] };
        },
      ];
      expect(settings.Name).toBe('main-db');
      expect(settings.TaskTemplate.ContainerSpec.Image).toBe(LIBSQL_IMAGE);
      // sqld authenticates over HTTP with basic auth derived from the
      // connection user and password.
      expect(settings.TaskTemplate.ContainerSpec.Env).toEqual(
        expect.arrayContaining([
          'SQLD_NODE=primary',
          'SQLD_HTTP_AUTH=basic:bGlic3FsX3VzZXI6c3VwM3JTM2NyZXQ=',
        ]),
      );
      // The image has no default listener config: the entrypoint always
      // launches sqld with explicit http/grpc/admin addresses.
      //
      // **`exec`, and it is a durability fix.** Without it dash
      // stays resident as PID 1 and a Stop is delivered to PID 1 only, so sqld
      // never sees the signal. Measured against
      // `ghcr.io/tursodatabase/libsql-server:v0.24.32` on Docker 29.3.1:
      // `docker stop -t 20` took the full **20.15 s**, the container exited
      // **137** and the log ended at *"initializing prometheus metrics"* with
      // no shutdown line anywhere in it; with `exec`, **0.24 s**, exit **0**,
      // `/proc/1/comm` reads `sqld` rather than `sh`, and the log carries
      // *"Got SIGTERM shutdown signal, gracefully shutting down"* and
      // *"sqld was shutdown gracefully. Bye!"*. The 30-second
      // `StopGracePeriod` `database-spec.ts` sets *so a database can flush to
      // disk* was being spent waiting on a shell that had already ignored the
      // signal, on every Stop, Remove containers and redeploy.
      expect(settings.TaskTemplate.ContainerSpec.Command).toEqual(['/bin/sh']);
      expect(settings.TaskTemplate.ContainerSpec.Args).toEqual([
        '-c',
        `exec ${DEFAULT_SQLD_COMMAND}`,
      ]);
      expect(settings.TaskTemplate.ContainerSpec.Mounts).toEqual([
        {
          Type: 'volume',
          Source: 'main-db-data',
          Target: '/var/lib/sqld',
        },
      ]);
      // No external ports yet: nothing published.
      expect(settings.EndpointSpec).toEqual({ Mode: 'dnsrr', Ports: [] });

      const found = await request(server)
        .get(`/libsql/${libsqlId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'done' });
    });

    it('a replica node points SQLD_PRIMARY_URL at its primary', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { libsqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
        { sqldNode: 'replica', sqldPrimaryUrl: 'http://primary-db:5001' },
      );

      await request(server)
        .post(`/libsql/${libsqlId}/deploy`)
        .set('Cookie', ownerSession.cookie);

      const [settings] = docker.createService.mock.lastCall as [
        { TaskTemplate: { ContainerSpec: { Env: string[] } } },
      ];
      expect(settings.TaskTemplate.ContainerSpec.Env).toEqual(
        expect.arrayContaining([
          'SQLD_NODE=replica',
          'SQLD_PRIMARY_URL=http://primary-db:5001',
        ]),
      );
    });

    it('enableNamespaces appends --enable-namespaces to the sqld command', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { libsqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
        { enableNamespaces: true },
      );

      await request(server)
        .post(`/libsql/${libsqlId}/deploy`)
        .set('Cookie', ownerSession.cookie);

      const [settings] = docker.createService.mock.lastCall as [
        { TaskTemplate: { ContainerSpec: { Args: string[] } } },
      ];
      expect(settings.TaskTemplate.ContainerSpec.Args).toEqual([
        '-c',
        `exec ${DEFAULT_SQLD_COMMAND} --enable-namespaces`,
      ]);
    });

    it('`exec`s a row-supplied command too, because the column is a program and its arguments', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { libsqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      const updated = await request(server)
        .patch(`/libsql/${libsqlId}`)
        .set('Cookie', ownerSession.cookie)
        .send({
          command: 'sqld --db-path other.db --http-listen-addr 0.0.0.0:8080',
        });
      expect(updated.status).toBe(200);

      await request(server)
        .post(`/libsql/${libsqlId}/deploy`)
        .set('Cookie', ownerSession.cookie);

      const [settings] = docker.createService.mock.lastCall as [
        { TaskTemplate: { ContainerSpec: { Args: string[] } } },
      ];
      // The rejected alternative was `exec`ing only `DEFAULT_SQLD_COMMAND` and
      // leaving a row-supplied one unprefixed. That keeps the 20-second Stop
      // for exactly the rows that opted into running a real sqld variant, and
      // makes the emitted shape depend on which column the program came from.
      // `exec` would drop the tail of a compound program like `a && b` — but
      // `buildDatabaseServiceSpec` turns this same column into argv with
      // `command.split(' ')` for the four engines that have no
      // `containerCommand`, so the platform's own contract for it is a program
      // and its arguments, and libsql's `/bin/sh -c` wrapper is the outlier.
      expect(settings.TaskTemplate.ContainerSpec.Args).toEqual([
        '-c',
        'exec sqld --db-path other.db --http-listen-addr 0.0.0.0:8080',
      ]);
    });

    it('a failed deploy leaves the database in error status', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { libsqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      execMock.execAsync.mockRejectedValue(new Error('pull failed'));

      const deployed = await request(server)
        .post(`/libsql/${libsqlId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      // A Docker failure is a 409 naming what Docker said, not a bare 500.
      expect(deployed.status).toBe(409);
      expect((deployed.body as { message: string }).message).toContain(
        'pull failed',
      );

      const found = await request(server)
        .get(`/libsql/${libsqlId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'error' });
      expect(docker.createService).not.toHaveBeenCalled();
    });
  });

  describe('external ports', () => {
    it('saving external ports redeploys publishing them against 8080/5001/5000', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { libsqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const saved = await request(server)
        .post(`/libsql/${libsqlId}/external-ports`)
        .set('Cookie', ownerSession.cookie)
        .send({
          externalPort: 8081,
          externalGRPCPort: 5002,
          externalAdminPort: 5003,
        });
      expect(saved.status).toBe(200);

      // The save itself converges the service with the published ports.
      expect(docker.createService).toHaveBeenCalledTimes(1);
      const [settings] = docker.createService.mock.lastCall as [
        { EndpointSpec: { Mode: string; Ports: unknown[] } },
      ];
      expect(settings.EndpointSpec).toEqual({
        Mode: 'dnsrr',
        Ports: [
          {
            Protocol: 'tcp',
            TargetPort: 8080,
            PublishedPort: 8081,
            PublishMode: 'host',
          },
          {
            Protocol: 'tcp',
            TargetPort: 5001,
            PublishedPort: 5002,
            PublishMode: 'host',
          },
          {
            Protocol: 'tcp',
            TargetPort: 5000,
            PublishedPort: 5003,
            PublishMode: 'host',
          },
        ],
      });

      const found = await request(server)
        .get(`/libsql/${libsqlId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({
        externalPort: 8081,
        externalGRPCPort: 5002,
        externalAdminPort: 5003,
      });
    });

    it('publishes only the ports that are set', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { libsqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const saved = await request(server)
        .post(`/libsql/${libsqlId}/external-ports`)
        .set('Cookie', ownerSession.cookie)
        .send({
          externalPort: 8081,
          externalGRPCPort: null,
          externalAdminPort: null,
        });
      expect(saved.status).toBe(200);

      const [settings] = docker.createService.mock.lastCall as [
        { EndpointSpec: { Mode: string; Ports: unknown[] } },
      ];
      expect(settings.EndpointSpec).toEqual({
        Mode: 'dnsrr',
        Ports: [
          {
            Protocol: 'tcp',
            TargetPort: 8080,
            PublishedPort: 8081,
            PublishMode: 'host',
          },
        ],
      });
    });

    it('closing every port unpublishes them all', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { libsqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const published = await request(server)
        .post(`/libsql/${libsqlId}/external-ports`)
        .set('Cookie', ownerSession.cookie)
        .send({
          externalPort: 8081,
          externalGRPCPort: 5002,
          externalAdminPort: 5003,
        });
      expect(published.status).toBe(200);

      // Every port explicitly null closes the database back to unpublished —
      // the security control has to be reversible without deleting the row.
      const closed = await request(server)
        .post(`/libsql/${libsqlId}/external-ports`)
        .set('Cookie', ownerSession.cookie)
        .send({
          externalPort: null,
          externalGRPCPort: null,
          externalAdminPort: null,
        });
      expect(closed.status).toBe(200);

      // The closing save converges the service with nothing published.
      const [settings] = docker.createService.mock.lastCall as [
        { EndpointSpec: { Mode: string; Ports: unknown[] } },
      ];
      expect(settings.EndpointSpec).toEqual({ Mode: 'dnsrr', Ports: [] });

      const found = await request(server)
        .get(`/libsql/${libsqlId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({
        externalPort: null,
        externalGRPCPort: null,
        externalAdminPort: null,
      });
    });

    it('an empty body is rejected rather than read as closing every port', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { libsqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const saved = await request(server)
        .post(`/libsql/${libsqlId}/external-ports`)
        .set('Cookie', ownerSession.cookie)
        .send({});
      expect(saved.status).toBe(400);
      expect(docker.createService).not.toHaveBeenCalled();
    });

    it('a replica cannot publish a gRPC port', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { libsqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
        { sqldNode: 'replica', sqldPrimaryUrl: 'http://primary-db:5001' },
      );

      const saved = await request(server)
        .post(`/libsql/${libsqlId}/external-ports`)
        .set('Cookie', ownerSession.cookie)
        .send({
          externalPort: null,
          externalGRPCPort: 5002,
          externalAdminPort: null,
        });
      expect(saved.status).toBe(400);
      expect(docker.createService).not.toHaveBeenCalled();
    });
  });

  describe('status change', () => {
    it('changeStatus sets the status directly', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { libsqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const changed = await request(server)
        .post(`/libsql/${libsqlId}/status`)
        .set('Cookie', ownerSession.cookie)
        .send({ applicationStatus: 'error' });
      expect(changed.status).toBe(200);

      const found = await request(server)
        .get(`/libsql/${libsqlId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'error' });
    });
  });

  describe('rebuild', () => {
    it('removes the service and its data volume, then re-creates the service', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { libsqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      await request(server)
        .post(`/libsql/${libsqlId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      docker.createService.mockClear();
      execMock.execAsync.mockClear();

      const rebuilt = await request(server)
        .post(`/libsql/${libsqlId}/rebuild`)
        .set('Cookie', ownerSession.cookie);
      expect(rebuilt.status).toBe(200);

      const commands = execMock.execAsync.mock.calls.map(
        ([command]: [string]) => command,
      );
      expect(
        commands.some((command) =>
          command.includes('docker service rm main-db'),
        ),
      ).toBe(true);
      expect(
        commands.some((command) =>
          command.includes('docker volume rm main-db-data --force'),
        ),
      ).toBe(true);

      // A fresh deploy re-created the service afterwards.
      expect(docker.createService).toHaveBeenCalledTimes(1);
      const found = await request(server)
        .get(`/libsql/${libsqlId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'done' });
    });
  });

  /**
   * H-109. There was no `remove` describe here at all — the four sibling suites
   * each have this test and libsql had none, which is why H-104 called this file
   * *latent*: its presence-probe discriminator was stale exactly like the other
   * nine, its delete therefore 409'd on an `unknown` probe, and the suite stayed
   * green because no test ever asked what the delete answered. (H-104's own
   * message, and H-109's brief after it, say the test existed and merely failed
   * to assert the status; both were wrong about which — the assertion was not
   * weak, it was absent.)
   *
   * Shaped on `mariadb`/`mongo`/`mysql`/`redis`, which share this test verbatim,
   * rather than on `postgres`: postgres also owns the 409-and-force pair, and its
   * docblock says why it owns them alone — `remove` is
   * `BaseDatabaseService.remove` for all six engines, so the refusal paths are
   * covered once, in the file that declares itself their representative. What is
   * per-engine is that *this* controller and *this* appName reach that base and
   * come back 200 with the row gone, and that is what this asserts.
   */
  describe('remove', () => {
    it('removes the swarm service and the row', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { libsqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      await request(server)
        .post(`/libsql/${libsqlId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      execMock.execAsync.mockClear();

      const removed = await request(server)
        .delete(`/libsql/${libsqlId}`)
        .set('Cookie', ownerSession.cookie);
      // The assertion whose absence made this suite unable to fail: an `unknown`
      // probe answers 409 here, which is what a stale `isPresenceProbe` produces.
      expect(removed.status).toBe(200);

      const commands = execMock.execAsync.mock.calls.map(
        ([command]: [string]) => command,
      );
      expect(
        commands.some((command) =>
          command.includes('docker service rm main-db'),
        ),
      ).toBe(true);
      // And the probe the cascade fix turns on was issued *and recognised* by this file's
      // hand-written discriminator. The status assertion above already goes red
      // when it is not, but it goes red saying "409, expected 200" — one route
      // away from the cause. This line names it, and it is written here rather
      // than in the four siblings because this is the file the stale copy hid in.
      expect(commands.some(isPresenceProbe)).toBe(true);

      const found = await request(server)
        .get(`/libsql/${libsqlId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(404);
    });
  });

  describe('row-level access', () => {
    it('databases are invisible outside their own organization', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { libsqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;
      const secondOrgCtx = permissionCtx(ownerSession.id, secondOrgId);

      // Same user, but acting in the second organization: the database from
      // the first organization must not resolve, even for its creator.
      await expect(
        libsqlService.findOne(secondOrgCtx, libsqlId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        libsqlService.deploy(secondOrgCtx, libsqlId),
      ).rejects.toThrow(NotFoundException);
      expect(docker.createService).not.toHaveBeenCalled();
    });
  });
});
