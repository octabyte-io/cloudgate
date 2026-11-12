import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { MysqlService } from '../../src/databases/mysql/mysql.service';
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

describe('MySQL (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let mysqlService: MysqlService;

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
    mysqlService = ctx.app.get(MysqlService);
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
      .post('/mysql')
      .set('Cookie', cookie)
      .send({
        name: 'Main DB',
        appName: 'main-db',
        databaseName: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 'sup3rS3cret',
        databaseRootPassword: 'r00tS3cret',
        environmentId,
        ...overrides,
      });
    expect(created.status).toBe(201);
    return created.body as { mysqlId: string; appName: string };
  }

  describe('create', () => {
    it('creates a mysql database retrievable with its connection info', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();

      const created = await request(server)
        .post('/mysql')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Main DB',
          appName: 'main-db',
          databaseName: 'shop',
          databaseUser: 'shop_user',
          databasePassword: 'sup3rS3cret',
          databaseRootPassword: 'r00tS3cret',
          environmentId,
        });
      expect(created.status).toBe(201);
      const { mysqlId } = created.body as { mysqlId: string };
      expect(mysqlId).toEqual(expect.any(String));

      const found = await request(server)
        .get(`/mysql/${mysqlId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(200);
      // The connection info a client needs to reach the database.
      expect(found.body).toMatchObject({
        mysqlId,
        name: 'Main DB',
        appName: 'main-db',
        databaseName: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 'sup3rS3cret',
        databaseRootPassword: 'r00tS3cret',
        // No image given: the console's default, the config's too.
        dockerImage: 'mysql:8.4',
        applicationStatus: 'idle',
        externalPort: null,
        environmentId,
      });
    });

    it('rejects passwords with shell-dangerous characters', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();

      const badPassword = await request(server)
        .post('/mysql')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Main DB',
          databaseName: 'shop',
          databaseUser: 'shop_user',
          databasePassword: 'un$afe pa$$word!',
          environmentId,
        });
      expect(badPassword.status).toBe(400);

      const badRootPassword = await request(server)
        .post('/mysql')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Main DB',
          databaseName: 'shop',
          databaseUser: 'shop_user',
          databasePassword: 'sup3rS3cret',
          databaseRootPassword: 'un$afe pa$$word!',
          environmentId,
        });
      expect(badRootPassword.status).toBe(400);
    });

    it('generates passwords when none are supplied', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();

      const created = await request(server)
        .post('/mysql')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Main DB',
          databaseName: 'shop',
          databaseUser: 'shop_user',
          environmentId,
        });
      expect(created.status).toBe(201);
      const { databasePassword, databaseRootPassword } = created.body as {
        databasePassword: string;
        databaseRootPassword: string;
      };
      expect(databasePassword).toMatch(/^[a-z0-9]{16}$/);
      expect(databaseRootPassword).toMatch(/^[a-z0-9]{16}$/);
    });

    it('stores both passwords encrypted at rest', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();

      const created = await request(server)
        .post('/mysql')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Main DB',
          databaseName: 'shop',
          databaseUser: 'shop_user',
          databasePassword: 'sup3rS3cret',
          databaseRootPassword: 'r00tS3cret',
          environmentId,
        });
      expect(created.status).toBe(201);

      // Read the raw columns, bypassing the decrypting column type.
      const raw = await ctx.db.execute<{
        database_password: string;
        database_root_password: string;
      }>(sql`select database_password, database_root_password from mysql`);
      expect(raw.rows).toHaveLength(1);
      expect(raw.rows[0].database_password).not.toContain('sup3rS3cret');
      expect(raw.rows[0].database_root_password).not.toContain('r00tS3cret');
    });
  });

  describe('deploy', () => {
    it('pulls the image and creates the service with image, MYSQL_* env and data volume', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mysqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const deployed = await request(server)
        .post(`/mysql/${mysqlId}/deploy`)
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
      expectQuotedInCommand(pull ?? null, 'mysql:8.4');

      expect(docker.createService).toHaveBeenCalledTimes(1);
      const [settings] = docker.createService.mock.lastCall as [
        {
          Name: string;
          TaskTemplate: {
            ContainerSpec: {
              Image: string;
              Env: string[];
              Mounts: { Type: string; Source: string; Target: string }[];
            };
          };
          EndpointSpec: { Mode: string; Ports: unknown[] };
        },
      ];
      expect(settings.Name).toBe('main-db');
      expect(settings.TaskTemplate.ContainerSpec.Image).toBe('mysql:8.4');
      expect(settings.TaskTemplate.ContainerSpec.Env).toEqual(
        expect.arrayContaining([
          'MYSQL_USER=shop_user',
          'MYSQL_DATABASE=shop',
          'MYSQL_PASSWORD=sup3rS3cret',
          'MYSQL_ROOT_PASSWORD=r00tS3cret',
        ]),
      );
      expect(settings.TaskTemplate.ContainerSpec.Mounts).toEqual([
        {
          Type: 'volume',
          Source: 'main-db-data',
          Target: '/var/lib/mysql',
        },
      ]);
      // No external port yet: nothing published.
      expect(settings.EndpointSpec).toEqual({ Mode: 'dnsrr', Ports: [] });

      const found = await request(server)
        .get(`/mysql/${mysqlId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'done' });
    });

    it('a root databaseUser gets only MYSQL_DATABASE and MYSQL_ROOT_PASSWORD', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mysqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
        { databaseUser: 'root' },
      );

      await request(server)
        .post(`/mysql/${mysqlId}/deploy`)
        .set('Cookie', ownerSession.cookie);

      const [settings] = docker.createService.mock.lastCall as [
        { TaskTemplate: { ContainerSpec: { Env: string[] } } },
      ];
      expect(settings.TaskTemplate.ContainerSpec.Env).toEqual(
        expect.arrayContaining([
          'MYSQL_DATABASE=shop',
          'MYSQL_ROOT_PASSWORD=r00tS3cret',
        ]),
      );
      const envNames = settings.TaskTemplate.ContainerSpec.Env.map(
        (pair) => pair.split('=')[0],
      );
      expect(envNames).not.toContain('MYSQL_USER');
      expect(envNames).not.toContain('MYSQL_PASSWORD');
    });

    it('a failed deploy leaves the database in error status', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mysqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      execMock.execAsync.mockRejectedValue(new Error('pull failed'));

      const deployed = await request(server)
        .post(`/mysql/${mysqlId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      // A Docker failure is a 409 naming what Docker said, not a bare 500.
      expect(deployed.status).toBe(409);
      expect((deployed.body as { message: string }).message).toContain(
        'pull failed',
      );

      const found = await request(server)
        .get(`/mysql/${mysqlId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'error' });
      expect(docker.createService).not.toHaveBeenCalled();
    });
  });

  describe('status change', () => {
    it('start scales the service up and marks the database done', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mysqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const started = await request(server)
        .post(`/mysql/${mysqlId}/start`)
        .set('Cookie', ownerSession.cookie);
      expect(started.status).toBe(200);

      const commands = execMock.execAsync.mock.calls.map(
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

      const found = await request(server)
        .get(`/mysql/${mysqlId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'done' });
    });

    it('stop scales the service to zero and marks the database stopped, which a never-deployed row cannot be', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mysqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const stopped = await request(server)
        .post(`/mysql/${mysqlId}/stop`)
        .set('Cookie', ownerSession.cookie);
      expect(stopped.status).toBe(200);

      const commands = execMock.execAsync.mock.calls.map(
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

      const found = await request(server)
        .get(`/mysql/${mysqlId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'stopped' });
    });

    it('changeStatus sets the status directly', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mysqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const changed = await request(server)
        .post(`/mysql/${mysqlId}/status`)
        .set('Cookie', ownerSession.cookie)
        .send({ applicationStatus: 'error' });
      expect(changed.status).toBe(200);

      const found = await request(server)
        .get(`/mysql/${mysqlId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'error' });
    });
  });

  describe('external port', () => {
    it('saving an external port redeploys publishing it against 3306', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mysqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const saved = await request(server)
        .post(`/mysql/${mysqlId}/external-port`)
        .set('Cookie', ownerSession.cookie)
        .send({ externalPort: 3307 });
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
            TargetPort: 3306,
            PublishedPort: 3307,
            PublishMode: 'host',
          },
        ],
      });

      const found = await request(server)
        .get(`/mysql/${mysqlId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ externalPort: 3307 });
    });

    it('clearing the external port unpublishes it on the next converge', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mysqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      await request(server)
        .post(`/mysql/${mysqlId}/external-port`)
        .set('Cookie', ownerSession.cookie)
        .send({ externalPort: 3307 });

      const cleared = await request(server)
        .post(`/mysql/${mysqlId}/external-port`)
        .set('Cookie', ownerSession.cookie)
        .send({ externalPort: null });
      expect(cleared.status).toBe(200);

      const [settings] = docker.createService.mock.lastCall as [
        { EndpointSpec: { Mode: string; Ports: unknown[] } },
      ];
      expect(settings.EndpointSpec).toEqual({ Mode: 'dnsrr', Ports: [] });
    });
  });

  describe('rebuild', () => {
    it('removes the service and its data volume, then re-creates the service', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mysqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      await request(server)
        .post(`/mysql/${mysqlId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      docker.createService.mockClear();
      execMock.execAsync.mockClear();

      const rebuilt = await request(server)
        .post(`/mysql/${mysqlId}/rebuild`)
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
        .get(`/mysql/${mysqlId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'done' });
    });
  });

  describe('update and environment', () => {
    it('updates config and saves env vars that feed the next deploy', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mysqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const updated = await request(server)
        .patch(`/mysql/${mysqlId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'Renamed DB', memoryLimit: '268435456' });
      expect(updated.status).toBe(200);

      const savedEnv = await request(server)
        .patch(`/mysql/${mysqlId}/environment`)
        .set('Cookie', ownerSession.cookie)
        .send({ env: 'MYSQL_INITDB_SKIP_TZINFO=1' });
      expect(savedEnv.status).toBe(200);

      await request(server)
        .post(`/mysql/${mysqlId}/deploy`)
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
          'MYSQL_DATABASE=shop',
          'MYSQL_INITDB_SKIP_TZINFO=1',
        ]),
      );
      expect(settings.TaskTemplate.Resources.Limits.MemoryBytes).toBe(
        268435456,
      );

      const found = await request(server)
        .get(`/mysql/${mysqlId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ name: 'Renamed DB' });
    });
  });

  describe('remove', () => {
    it('removes the swarm service and the row', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mysqlId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      await request(server)
        .post(`/mysql/${mysqlId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      execMock.execAsync.mockClear();

      const removed = await request(server)
        .delete(`/mysql/${mysqlId}`)
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
        .get(`/mysql/${mysqlId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(404);
    });
  });

  describe('row-level access', () => {
    it('a member without a row-level grant can neither read nor operate', async () => {
      const { ownerSession, organizationId, environmentId } =
        await setUpEnvironment();
      const { mysqlId } = await createDatabase(
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

      await expect(mysqlService.findOne(inviteeCtx, mysqlId)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(mysqlService.deploy(inviteeCtx, mysqlId)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(mysqlService.start(inviteeCtx, mysqlId)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(mysqlService.rebuild(inviteeCtx, mysqlId)).rejects.toThrow(
        ForbiddenException,
      );

      // And over HTTP the same wall: 403, and nothing converged.
      const denied = await request(server)
        .post(`/mysql/${mysqlId}/deploy`)
        .set('Cookie', invitee.cookie);
      expect(denied.status).toBe(403);
      expect(docker.createService).not.toHaveBeenCalled();
    });

    it('databases are invisible outside their own organization', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { mysqlId } = await createDatabase(
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
      await expect(mysqlService.findOne(secondOrgCtx, mysqlId)).rejects.toThrow(
        NotFoundException,
      );
      await expect(mysqlService.deploy(secondOrgCtx, mysqlId)).rejects.toThrow(
        NotFoundException,
      );
      await expect(mysqlService.rebuild(secondOrgCtx, mysqlId)).rejects.toThrow(
        NotFoundException,
      );
      expect(docker.createService).not.toHaveBeenCalled();
    });
  });
});
