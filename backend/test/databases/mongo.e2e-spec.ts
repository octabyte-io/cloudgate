import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { MongoService } from '../../src/databases/mongo/mongo.service';
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

/** Invites a user into the owner's organization and accepts as them. */
async function inviteUser(
  server: App,
  ownerCookie: string,
  email: string,
  role: 'admin' | 'member',
): Promise<{ cookie: string; id: string }> {
  const invite = await request(server)
    .post('/organizations/invitations')
    .set('Cookie', ownerCookie)
    .send({ email, role });
  const inviteId = (invite.body as { id: string }).id;

  const su = await request(server)
    .post('/api/auth/sign-up/email')
    .set('x-cloudgate-token', inviteId)
    .send({ name: 'Ida Rhodes', email, password: 'super-secret-password' });
  const cookie = su.headers['set-cookie'];
  const id = (su.body as { user: { id: string } }).user.id;

  const accept = await request(server)
    .post(`/organizations/invitations/${inviteId}/accept`)
    .set('Cookie', cookie);
  expect(accept.status).toBe(201);

  return { cookie, id };
}

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

describe('MongoDB (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let mongoService: MongoService;

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
    mongoService = ctx.app.get(MongoService);
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

  describe('create', () => {
    it('creates a mongo database retrievable with its connection info', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();

      const created = await request(server)
        .post('/mongo')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Main DB',
          appName: 'main-db',
          databaseUser: 'mongo_user',
          databasePassword: 'sup3rS3cret',
          environmentId,
        });
      expect(created.status).toBe(201);
      const { mongoId } = created.body as { mongoId: string };
      expect(mongoId).toEqual(expect.any(String));

      const found = await request(server)
        .get(`/mongo/${mongoId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(200);
      // The connection info a client needs to reach the database — MongoDB
      // has no separate database name: the root user owns the whole server.
      expect(found.body).toMatchObject({
        mongoId,
        name: 'Main DB',
        appName: 'main-db',
        databaseUser: 'mongo_user',
        databasePassword: 'sup3rS3cret',
        dockerImage: 'mongo:8',
        replicaSets: false,
        applicationStatus: 'idle',
        externalPort: null,
        environmentId,
      });
    });

    it('rejects passwords with shell-dangerous characters', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();

      const badPassword = await request(server)
        .post('/mongo')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Main DB',
          databaseUser: 'mongo_user',
          databasePassword: 'un$afe pa$$word!',
          environmentId,
        });
      expect(badPassword.status).toBe(400);
    });

    it('generates a password when none is supplied and stores it encrypted', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();

      const created = await request(server)
        .post('/mongo')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Main DB',
          databaseUser: 'mongo_user',
          environmentId,
        });
      expect(created.status).toBe(201);
      const { databasePassword } = created.body as {
        databasePassword: string;
      };
      expect(databasePassword).toMatch(/^[a-z0-9]{16}$/);

      // Read the raw column, bypassing the decrypting column type.
      const raw = await ctx.db.execute<{ database_password: string }>(
        sql`select database_password from mongo`,
      );
      expect(raw.rows).toHaveLength(1);
      expect(raw.rows[0].database_password).not.toContain(databasePassword);
    });
  });

  /** Creates a database over HTTP as the owner and returns its row. */
  async function createDatabase(
    cookie: string,
    environmentId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const created = await request(server)
      .post('/mongo')
      .set('Cookie', cookie)
      .send({
        name: 'Main DB',
        appName: 'main-db',
        databaseUser: 'mongo_user',
        databasePassword: 'sup3rS3cret',
        environmentId,
        ...overrides,
      });
    expect(created.status).toBe(201);
    return created.body as { mongoId: string; appName: string };
  }

  describe('deploy', () => {
    it('pulls the image and creates the service with image, MONGO_INITDB_* env and data volume', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mongoId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const deployed = await request(server)
        .post(`/mongo/${mongoId}/deploy`)
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
      expectQuotedInCommand(pull ?? null, 'mongo:8');

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
            };
          };
          EndpointSpec: { Mode: string; Ports: unknown[] };
        },
      ];
      expect(settings.Name).toBe('main-db');
      expect(settings.TaskTemplate.ContainerSpec.Image).toBe('mongo:8');
      expect(settings.TaskTemplate.ContainerSpec.Env).toEqual(
        expect.arrayContaining([
          'MONGO_INITDB_ROOT_USERNAME=mongo_user',
          'MONGO_INITDB_ROOT_PASSWORD=sup3rS3cret',
        ]),
      );
      // Plain single-node mongod: no command override.
      expect(settings.TaskTemplate.ContainerSpec.Command).toBeUndefined();
      expect(settings.TaskTemplate.ContainerSpec.Mounts).toEqual([
        {
          Type: 'volume',
          Source: 'main-db-data',
          Target: '/data/db',
        },
      ]);
      // No external port yet: nothing published.
      expect(settings.EndpointSpec).toEqual({ Mode: 'dnsrr', Ports: [] });

      const found = await request(server)
        .get(`/mongo/${mongoId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'done' });
    });

    it('replicaSets mode boots a single-node replica set via a startup script', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mongoId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
        { replicaSets: true },
      );

      await request(server)
        .post(`/mongo/${mongoId}/deploy`)
        .set('Cookie', ownerSession.cookie);

      const [settings] = docker.createService.mock.lastCall as [
        {
          TaskTemplate: {
            ContainerSpec: { Env: string[]; Command: string[]; Args: string[] };
          };
        },
      ];
      // Bootstraps mongod with --replSet and initiates rs0 pointing at the
      // service's own DNS name, creating the root user afterwards.
      expect(settings.TaskTemplate.ContainerSpec.Command).toEqual([
        '/bin/bash',
      ]);
      const [dashC, script] = settings.TaskTemplate.ContainerSpec.Args;
      expect(dashC).toBe('-c');
      expect(script).toContain('mongod --port 27017 --replSet rs0');
      expect(script).toContain('rs.initiate');
      expect(script).toContain('host: "main-db:27017"');

      // **The root credentials are referenced, not written.** This
      // script *is* PID 1 of the container — unlike redis's wrapper, which
      // `redis-server` argv-rewrites away — and the whole of it is
      // `ContainerSpec.Args`, so a password spelled here sat in
      // `/proc/1/cmdline`. Measured against mongo:8 on Docker 29.3.1 through a
      // `--pid=container` sidecar running as uid 65534: that file is
      // `-r--r--r--` and the password was readable out of it for the
      // container's whole life, where `/proc/1/environ` is `-r--------` and
      // the same account is refused. `mongo.service.ts` carries the numbers and
      // says why `process.env` inside the JS beats the shell expansion the ticket
      // proposed.
      expect(script).toContain('user: process.env.CG_MONGO_ROOT_USERNAME');
      expect(script).toContain('pwd: process.env.CG_MONGO_ROOT_PASSWORD');
      expect(script).not.toContain('sup3rS3cret');
      expect(script).not.toContain('mongo_user');

      // **The Stop has to reach mongod.** `exec` is unavailable
      // here — `rs.initiate` needs a *running* mongod, so the shell has to
      // outlive the start — which leaves bash as PID 1, and a Stop is
      // delivered to PID 1 only. Measured: without the trap
      // `docker stop -t 20` took **20.15 s**, the container exited **137** and
      // mongod logged no `SignalHandler` line at all; with it, **0.15 s**,
      // exit **0**, and 122 of them ending in `mongod shutdown complete`.
      //
      // Anchored to the start of a line rather than matched as a substring,
      // and the handler body asserted beside the `trap`: commenting the line
      // out is the one-character way to lose this and `toContain` cannot see
      // it — `'# trap forwardStop TERM INT'` contains the substring, which is
      // how this assertion passed its own mutation once.
      expect(script).toMatch(/^trap forwardStop TERM INT$/m);
      expect(script).toMatch(/^\tkill -TERM "\$MONGOD_PID"/m);
      expect(script).toMatch(/^\twait "\$MONGOD_PID"/m);
      // The tail stays a `wait` — inside `exitWithMongod`, which also hands
      // mongod's exit status on — because `wait` is the one builtin a
      // trapped signal interrupts: relaying the signal buys nothing if the
      // shell is parked in something that defers the trap. What the script
      // does when it runs is pinned under real bash in
      // `mongo-replica-set-script.spec.ts`.
      expect(script).toMatch(/^exitWithMongod\(\) \{\n\twait "\$MONGOD_PID"$/m);
      expect(script.trimEnd()).toMatch(/\nexitWithMongod "[^"\n]*"$/);

      // The replica-set branch carries the two holders the script reads.
      // Holders rather than the `MONGO_INITDB_*` pair beside them:
      // `deployInternal` used to append the row's own `env` after this string
      // and dotenv let the later assignment win, so a script reading an
      // operator-writable name would let the operator set a root password
      // `mongo.databasePassword` does not hold — the exact defect the stdin-login
      // change invented `CG_REDIS_REQUIREPASS` to avoid, and the one
      // `reserved-env.ts` refuses at the write.
      expect(settings.TaskTemplate.ContainerSpec.Env).toEqual(
        expect.arrayContaining([
          'MONGO_INITDB_ROOT_USERNAME=mongo_user',
          'MONGO_INITDB_ROOT_PASSWORD=sup3rS3cret',
          'CG_MONGO_ROOT_USERNAME=mongo_user',
          'CG_MONGO_ROOT_PASSWORD=sup3rS3cret',
        ]),
      );
      // `MONGO_INITDB_DATABASE=admin` used to be here, and this is the branch
      // that proves it was dead: the assertions above show PID 1
      // is `/bin/bash -c <script>`, so the image's `docker-entrypoint.sh` —
      // the only thing that reads that variable — never runs, and the script
      // names the database itself with `getSiblingDB("admin")`. It set a
      // variable nothing could read, and the docblock's
      // claim that replica-set mode "additionally seeds the admin database"
      // rested on it.
      expect(script).toContain('getSiblingDB("admin")');
      expect(
        settings.TaskTemplate.ContainerSpec.Env.map(
          (pair) => pair.split('=')[0],
        ),
      ).not.toContain('MONGO_INITDB_DATABASE');
    });

    it('a non-replica-set row carries neither holder, because nothing reads them', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mongoId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      await request(server)
        .post(`/mongo/${mongoId}/deploy`)
        .set('Cookie', ownerSession.cookie);

      const [settings] = docker.createService.mock.lastCall as [
        { TaskTemplate: { ContainerSpec: { Env: string[] } } },
      ];
      // The holders exist for `replicaSetStartupScript` and for nothing else:
      // on this branch the image's own entrypoint runs and reads
      // `MONGO_INITDB_ROOT_*`. Two more names in the container's environment
      // for a reader that is not there is the kind of thing that survives by
      // symmetry, so it is pinned as absent.
      const env = settings.TaskTemplate.ContainerSpec.Env;
      expect(env).toEqual(
        expect.arrayContaining(['MONGO_INITDB_ROOT_PASSWORD=sup3rS3cret']),
      );
      expect(env.some((pair) => pair.startsWith('CG_'))).toBe(false);
    });

    it('a failed deploy leaves the database in error status', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mongoId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      execMock.execAsync.mockRejectedValue(new Error('pull failed'));

      const deployed = await request(server)
        .post(`/mongo/${mongoId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      // A Docker failure is a 409 naming what Docker said, not a bare 500.
      expect(deployed.status).toBe(409);
      expect((deployed.body as { message: string }).message).toContain(
        'pull failed',
      );

      const found = await request(server)
        .get(`/mongo/${mongoId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'error' });
      expect(docker.createService).not.toHaveBeenCalled();
    });
  });

  describe('status change', () => {
    it('start scales the service up and stop scales it to zero', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mongoId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const started = await request(server)
        .post(`/mongo/${mongoId}/start`)
        .set('Cookie', ownerSession.cookie);
      expect(started.status).toBe(200);
      let commands = execMock.execAsync.mock.calls.map(
        ([command]: [string]) => command,
      );
      // `shell-quote` escapes the `=` in the scaled word (`main-db\\=1`),
      // which the shell strips before `docker` sees it — so this parses the
      // command the argv worded to rather than matching its spelling.
      expectQuotedInCommand(
        commands.find((command) =>
          command.startsWith('docker service scale'),
        ) ?? null,
        'main-db=1',
      );
      let found = await request(server)
        .get(`/mongo/${mongoId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'done' });

      execMock.execAsync.mockClear();
      const stopped = await request(server)
        .post(`/mongo/${mongoId}/stop`)
        .set('Cookie', ownerSession.cookie);
      expect(stopped.status).toBe(200);
      commands = execMock.execAsync.mock.calls.map(
        ([command]: [string]) => command,
      );
      // `shell-quote` escapes the `=` in the scaled word (`main-db\\=0`),
      // which the shell strips before `docker` sees it — so this parses the
      // command the argv worded to rather than matching its spelling.
      expectQuotedInCommand(
        commands.find((command) =>
          command.startsWith('docker service scale'),
        ) ?? null,
        'main-db=0',
      );
      found = await request(server)
        .get(`/mongo/${mongoId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'stopped' });
    });

    it('changeStatus sets the status directly', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mongoId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const changed = await request(server)
        .post(`/mongo/${mongoId}/status`)
        .set('Cookie', ownerSession.cookie)
        .send({ applicationStatus: 'error' });
      expect(changed.status).toBe(200);

      const found = await request(server)
        .get(`/mongo/${mongoId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'error' });
    });
  });

  describe('external port', () => {
    it('saving an external port redeploys publishing it against 27017', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mongoId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const saved = await request(server)
        .post(`/mongo/${mongoId}/external-port`)
        .set('Cookie', ownerSession.cookie)
        .send({ externalPort: 27018 });
      expect(saved.status).toBe(200);

      // The save itself converges the service with the published port.
      expect(docker.createService).toHaveBeenCalledTimes(1);
      const [settings] = docker.createService.mock.lastCall as [
        { EndpointSpec: { Mode: string; Ports: unknown[] } },
      ];
      expect(settings.EndpointSpec).toEqual({
        Mode: 'dnsrr',
        Ports: [
          {
            Protocol: 'tcp',
            TargetPort: 27017,
            PublishedPort: 27018,
            PublishMode: 'host',
          },
        ],
      });

      const found = await request(server)
        .get(`/mongo/${mongoId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ externalPort: 27018 });
    });
  });

  describe('rebuild', () => {
    it('removes the service and its data volume, then re-creates the service', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mongoId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      await request(server)
        .post(`/mongo/${mongoId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      docker.createService.mockClear();
      execMock.execAsync.mockClear();

      const rebuilt = await request(server)
        .post(`/mongo/${mongoId}/rebuild`)
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
        .get(`/mongo/${mongoId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'done' });
    });
  });

  describe('update and environment', () => {
    it('updates config and saves env vars that feed the next deploy', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mongoId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const updated = await request(server)
        .patch(`/mongo/${mongoId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'Renamed DB', memoryLimit: '268435456' });
      expect(updated.status).toBe(200);

      const savedEnv = await request(server)
        .patch(`/mongo/${mongoId}/environment`)
        .set('Cookie', ownerSession.cookie)
        .send({ env: 'MONGO_INITDB_DATABASE=analytics' });
      expect(savedEnv.status).toBe(200);

      await request(server)
        .post(`/mongo/${mongoId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      const [settings] = docker.createService.mock.lastCall as [
        {
          TaskTemplate: {
            ContainerSpec: { Env: string[] };
            Resources: { Limits: { MemoryBytes?: number } };
          };
        },
      ];
      expect(settings.TaskTemplate.ContainerSpec.Env).toEqual(
        expect.arrayContaining([
          'MONGO_INITDB_ROOT_USERNAME=mongo_user',
          'MONGO_INITDB_DATABASE=analytics',
        ]),
      );
      expect(settings.TaskTemplate.Resources.Limits.MemoryBytes).toBe(
        268435456,
      );

      const found = await request(server)
        .get(`/mongo/${mongoId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ name: 'Renamed DB' });
    });
  });

  describe('remove', () => {
    it('removes the swarm service and the row', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mongoId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      await request(server)
        .post(`/mongo/${mongoId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      execMock.execAsync.mockClear();

      const removed = await request(server)
        .delete(`/mongo/${mongoId}`)
        .set('Cookie', ownerSession.cookie);
      expect(removed.status).toBe(200);

      const commands = execMock.execAsync.mock.calls.map(
        ([command]: [string]) => command,
      );
      expect(
        commands.some((command) =>
          command.includes('docker service rm main-db'),
        ),
      ).toBe(true);

      const found = await request(server)
        .get(`/mongo/${mongoId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(404);
    });
  });

  describe('row-level access', () => {
    it('a member without a row-level grant can neither read nor operate', async () => {
      const { ownerSession, organizationId, environmentId } =
        await setUpEnvironment();
      const { mongoId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      const inviteeCtx = permissionCtx(invitee.id, organizationId);

      await expect(mongoService.findOne(inviteeCtx, mongoId)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(mongoService.deploy(inviteeCtx, mongoId)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(mongoService.rebuild(inviteeCtx, mongoId)).rejects.toThrow(
        ForbiddenException,
      );

      // And over HTTP the same wall: 403, and nothing converged.
      const denied = await request(server)
        .post(`/mongo/${mongoId}/deploy`)
        .set('Cookie', invitee.cookie);
      expect(denied.status).toBe(403);
      expect(docker.createService).not.toHaveBeenCalled();
    });

    it('databases are invisible outside their own organization', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mongoId } = await createDatabase(
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
      await expect(mongoService.findOne(secondOrgCtx, mongoId)).rejects.toThrow(
        NotFoundException,
      );
      await expect(mongoService.deploy(secondOrgCtx, mongoId)).rejects.toThrow(
        NotFoundException,
      );
      expect(docker.createService).not.toHaveBeenCalled();
    });
  });
});
