import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { z } from 'zod';
import { ApplicationsService } from '../../src/applications/applications.service';
import { cloudgateDirectoryOn } from '../../src/common/config/cloudgate-directory';
import { fileMountsDirectoryOnRunServer } from '../../src/deployment-engine/deployment-engine.paths';
import {
  generateBindMounts,
  generateFileMounts,
  generateVolumeMounts,
} from '../../src/docker/docker.utils';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { createMountSchema } from '../../src/mounts/dto/mount.dto';
import { mount } from '../../src/mounts/mount.schema';
import { MountsService } from '../../src/mounts/mounts.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { PermissionCtx } from '../../src/rbac/permission.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
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

/** The owner's bootstrap organization plus a service-seam permission ctx. */
async function setUpOwner(server: App) {
  const ownerSession = await signUp(server, owner);

  const orgs = await request(server)
    .get('/organizations')
    .set('Cookie', ownerSession.cookie);
  const organizationId = (orgs.body as { id: string }[])[0].id;

  return { organizationId, owner: ownerSession };
}

/**
 * The directory a Service's file mounts are written into and bind-mounted from,
 * on the machine that **runs** it: a bind source is a path the run Server's
 * daemon resolves, so that machine's root is the one it takes
 * (`fileMountsDirectoryOnRunServer`'s docblock). Every Service in this file is
 * created without a Server, so its run Server is the platform host and the root
 * is this process's own `CLOUDGATE_DIRECTORY`.
 *
 * These expectations spelled `/etc/cloudgate`, which is a Server's root and is
 * the platform host's only while that variable is unset — so they were green by
 * coincidence rather than by being right. Built from
 * `cloudgateDirectoryOn` plus the literal tail rather than from
 * `fileMountsDirectoryOnRunServer`, which is what the code under test asks
 * (§1.7).
 */
const filesOn = (runServerId: string | null, appName: string) =>
  `${cloudgateDirectoryOn(runServerId)}/applications/${appName}/files`;

/**
 * What a file-mount write runs before it writes: the Service directory
 * above `files` made `0700`, so the content is out of every local account's
 * reach while the file keeps the mode the container reads it with. Spelled out
 * rather than taken from `ownerOnlyDirectoryCommand`, so a change to the helper
 * is a change these assertions see.
 */
const closeServiceDirectory = (files: string) => {
  const service = files.replace(/\/files$/, '');
  return `mkdir -p ${service} && chmod 700 ${service}`;
};

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

describe('Mounts (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let postgres: PostgresService;
  let mounts: MountsService;

  /**
   * Creates a mount from a request-shaped fixture. `serviceType` carries a
   * zod `.default()`, so it is optional on the schema's *input* and required
   * on its output — and `CreateMountDto` is typed from the output. Fixtures
   * that omit it stand in for an HTTP caller that omits it, so they are typed
   * from the input and put through the schema here, exactly as the
   * ZodValidationPipe does before a request body reaches the service.
   */
  const createMount = (
    permCtx: PermissionCtx,
    data: z.input<typeof createMountSchema>,
  ) => mounts.create(permCtx, createMountSchema.parse(data));

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
    applications = ctx.app.get(ApplicationsService);
    postgres = ctx.app.get(PostgresService);
    mounts = ctx.app.get(MountsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    execMock.execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    dockerService.inspect
      .mockReset()
      .mockRejectedValue(new Error('no such service'));
    dockerService.update.mockReset().mockResolvedValue(undefined);
    docker.getService.mockClear();
    docker.createService.mockReset().mockResolvedValue(undefined);
    dockerFactoryMock.getRemoteDocker.mockClear();
  });

  /** An owner ctx plus a project + environment + application to attach mounts to. */
  async function setUpApplication() {
    const { organizationId, owner: ownerSession } = await setUpOwner(server);
    const ownerCtx = permissionCtx(ownerSession.id, organizationId);
    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    const application = await applications.create(ownerCtx, {
      name: 'Blog',
      appName: 'blog-app',
      environmentId: environment.environmentId,
    });
    return {
      organizationId,
      ownerSession,
      ownerCtx,
      project,
      environment,
      application,
    };
  }

  describe('create → findOne per mount type', () => {
    it('creates a volume mount retrievable by id', async () => {
      const { ownerCtx, application } = await setUpApplication();

      const created = await createMount(ownerCtx, {
        type: 'volume',
        volumeName: 'blog-uploads',
        mountPath: '/app/uploads',
        serviceId: application.applicationId,
      });

      expect(created.mountId).toEqual(expect.any(String));
      expect(created.serviceType).toBe('application');
      expect(created.applicationId).toBe(application.applicationId);

      const found = await mounts.findOne(ownerCtx, created.mountId);
      expect(found).toMatchObject({
        mountId: created.mountId,
        type: 'volume',
        volumeName: 'blog-uploads',
        mountPath: '/app/uploads',
      });
      // No file to materialize for a volume mount.
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });

    it('creates a bind mount retrievable by id', async () => {
      const { ownerCtx, application } = await setUpApplication();

      const created = await createMount(ownerCtx, {
        type: 'bind',
        hostPath: '/var/data/blog',
        mountPath: '/app/data',
        serviceId: application.applicationId,
      });

      const found = await mounts.findOne(ownerCtx, created.mountId);
      expect(found).toMatchObject({
        type: 'bind',
        hostPath: '/var/data/blog',
        mountPath: '/app/data',
      });
    });

    it('creates a file mount and materializes the file on the build server', async () => {
      const { ownerCtx, application } = await setUpApplication();

      const created = await createMount(ownerCtx, {
        type: 'file',
        filePath: 'config.json',
        content: 'hello world',
        mountPath: '/app/config.json',
        serviceId: application.applicationId,
      });

      // A file mount's content lands under the service's files directory,
      // base64-encoded in transit ('hello world').
      const files = filesOn(application.serverId, 'blog-app');
      expect(execMock.execAsync).toHaveBeenCalledWith(
        `${closeServiceDirectory(files)};\n` +
          `mkdir -p "${files}";\n` +
          'echo "aGVsbG8gd29ybGQ=" | base64 -d > ' +
          `"${files}/config.json";\n`,
      );

      const found = await mounts.findOne(ownerCtx, created.mountId);
      expect(found).toMatchObject({
        type: 'file',
        filePath: 'config.json',
        content: 'hello world',
        mountPath: '/app/config.json',
      });
    });

    it('encrypts file-mount content at rest', async () => {
      const { ownerCtx, application } = await setUpApplication();

      const created = await createMount(ownerCtx, {
        type: 'file',
        filePath: 'secrets.env',
        content: 'API_KEY=super-secret',
        mountPath: '/app/secrets.env',
        serviceId: application.applicationId,
      });

      const raw = await ctx.db.execute(
        sql`SELECT content FROM mount WHERE mount_id = ${created.mountId}`,
      );
      const stored = (raw.rows[0] as { content: string }).content;
      expect(stored).not.toContain('API_KEY=super-secret');
    });
  });

  /**
   * `create` inserted the row and *then* materialized the file on the
   * build server, so a server that could not take it answered 500 and kept a
   * mount whose file does not exist — one the next deploy bind-mounts at a path
   * with nothing behind it. The insert is now the last thing that can fail.
   */
  describe('a create whose file cannot be written', () => {
    const fileMount = (serviceId: string) => ({
      type: 'file' as const,
      filePath: 'config.json',
      content: 'hello world',
      mountPath: '/app/config.json',
      serviceId,
    });

    it('materializes the file before the row exists', async () => {
      const { ownerCtx, application } = await setUpApplication();

      // Read the table from inside the exec, which is the only moment the
      // ordering is observable: an insert-then-write create passes every
      // after-the-fact assertion this file makes.
      let rowsDuringWrite: unknown[] | undefined;
      let commandDuringWrite: string | undefined;
      execMock.execAsync.mockImplementationOnce(async (command: string) => {
        rowsDuringWrite = await ctx.db.select().from(mount);
        commandDuringWrite = command;
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      const created = await createMount(
        ownerCtx,
        fileMount(application.applicationId),
      );

      expect(rowsDuringWrite).toHaveLength(0);
      expect(commandDuringWrite).toContain(
        `${filesOn(application.serverId, 'blog-app')}/config.json`,
      );
      const rows = await ctx.db.select().from(mount);
      expect(rows).toHaveLength(1);
      expect(rows[0].mountId).toBe(created.mountId);
    });

    it('leaves no mount row when the file cannot be written on the build server', async () => {
      const { ownerCtx, application } = await setUpApplication();
      execMock.execAsync.mockRejectedValueOnce(
        new Error('Cannot parse privateKey: Malformed OpenSSH private key'),
      );

      await expect(
        createMount(ownerCtx, fileMount(application.applicationId)),
      ).rejects.toThrow('Malformed OpenSSH private key');

      // Nothing was written on the way to being refused.
      expect(await ctx.db.select().from(mount)).toHaveLength(0);
    });

    it('leaves a volume mount untouched by the reorder', async () => {
      // Only a file mount has a host-side write; the other two types must
      // still reach the insert with nothing having run before it.
      const { ownerCtx, application } = await setUpApplication();

      const created = await createMount(ownerCtx, {
        type: 'volume',
        volumeName: 'blog-uploads',
        mountPath: '/app/uploads',
        serviceId: application.applicationId,
      });

      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(await ctx.db.select().from(mount)).toHaveLength(1);
      expect(created.type).toBe('volume');
    });

    /**
     * The reorder's enabler, which closes a traversal in passing: the write
     * has to happen before the row exists, so what a caller-supplied
     * `filePath` may be had to be decided. `getCreateFileCommand` joins it onto
     * the service's files directory and `path.join` normalises, so `../`
     * segments walked out of it — into the host's Traefik config, or into
     * another Organization's service. `mount.dto.spec.ts` holds the rule; this
     * pins that the global pipe applies it and that nothing is written.
     */
    it('refuses a filePath that escapes the service files directory', async () => {
      const { ownerSession, application } = await setUpApplication();

      const refused = await request(server)
        .post('/mounts')
        .set('Cookie', ownerSession.cookie)
        .send({
          type: 'file',
          filePath: '../../../traefik/dynamic/traefik.yml',
          content: 'http: {}',
          mountPath: '/app/config.json',
          serviceId: application.applicationId,
        });
      expect(refused.status).toBe(400);

      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(await ctx.db.select().from(mount)).toHaveLength(0);
    });
  });

  /**
   * H-12 of the third fix-wave verification. `getCreateFileCommand`
   * interpolated the joined path into two *unquoted* `mkdir -p` words and the
   * command goes to `RemoteExecService`, so a `filePath` of `a$(id)/` ran on
   * the build server as the account that drives Docker. Both words are
   * double-quoted now: the first fix shipped the refusal alone, and
   * `SHELL_UNSAFE` is the set for a *quoted* word, so `;` walked straight
   * through it until the quotes went in. The traversal rule does not constrain
   * the *characters* in a path — `files/a$(id)` normalises somewhere perfectly
   * legal — so it got through the DTO and the refusal had to live in the builder
   * itself, where the two routes that bypass `createMountSchema` also pass.
   * `docker.utils.spec.ts` holds the rule; these pin that a request carrying
   * one is answered 400 with nothing having run.
   */
  describe('a filePath carrying a shell metacharacter', () => {
    const postMount = (cookie: string, serviceId: string, filePath: string) =>
      request(server).post('/mounts').set('Cookie', cookie).send({
        type: 'file',
        filePath,
        content: 'hello world',
        mountPath: '/app/config.json',
        serviceId,
      });

    it('is refused, and nothing is written', async () => {
      const { ownerSession, application } = await setUpApplication();

      // The command substitution, its backtick spelling, and one that hides
      // behind a legal leading segment so the traversal rule cannot see it.
      for (const filePath of [
        'a$(id)/',
        'a`whoami`/',
        'files/$(id)/app.yml',
        'files/config"; rm -rf /; echo "',
      ]) {
        const refused = await postMount(
          ownerSession.cookie,
          application.applicationId,
          filePath,
        );
        expect(refused.status).toBe(400);
      }

      // Nothing ran on the build server on the way to being refused, and no
      // row was minted either — the write is the first thing `create` does.
      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
      expect(await ctx.db.select().from(mount)).toHaveLength(0);
    });

    it('does not refuse the legitimate path next door to it', async () => {
      const { ownerSession, application } = await setUpApplication();

      const created = await postMount(
        ownerSession.cookie,
        application.applicationId,
        'files/config/app.yml',
      );
      expect(created.status).toBe(201);
      const files = filesOn(application.serverId, 'blog-app');
      expect(execMock.execAsync).toHaveBeenCalledWith(
        `${closeServiceDirectory(files)};\n` +
          `mkdir -p "${files}/files/config";\n` +
          'echo "aGVsbG8gd29ybGQ=" | base64 -d > ' +
          `"${files}/files/config/app.yml";\n`,
      );
    });

    /**
     * `remove` builds `rm -rf "<joined path>"` over the same stored value, and
     * `$`/backtick substitute inside double quotes too — so the double-quoted
     * word it was already interpolated into was not a fix. Reachable only for a
     * row minted before this one, which is why the row is inserted directly.
     */
    it('is refused on the way out too, rather than running in the rm -rf', async () => {
      const { ownerSession, application } = await setUpApplication();
      const [legacy] = await ctx.db
        .insert(mount)
        .values({
          type: 'file',
          filePath: 'a$(id)/config.json',
          content: 'hello world',
          mountPath: '/app/config.json',
          serviceType: 'application',
          applicationId: application.applicationId,
        })
        .returning();

      const refused = await request(server)
        .delete(`/mounts/${legacy.mountId}`)
        .set('Cookie', ownerSession.cookie);
      expect(refused.status).toBe(400);

      // No rm ran; the row outliving the request is the deliberate trade —
      // refusing a delete is recoverable, running the payload is not.
      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(await ctx.db.select().from(mount)).toHaveLength(1);
    });
  });

  describe('deploy spec', () => {
    it('surfaces application mounts to the deploy spec through the Phase-12 helpers', async () => {
      const { ownerCtx, application } = await setUpApplication();
      await createMount(ownerCtx, {
        type: 'volume',
        volumeName: 'blog-uploads',
        mountPath: '/app/uploads',
        serviceId: application.applicationId,
      });
      await createMount(ownerCtx, {
        type: 'bind',
        hostPath: '/var/data/blog',
        mountPath: '/app/data',
        serviceId: application.applicationId,
      });
      await createMount(ownerCtx, {
        type: 'file',
        filePath: 'config.json',
        content: '{"debug":false}',
        mountPath: '/app/config.json',
        serviceId: application.applicationId,
      });

      const deployable = await applications.findDeployable(
        application.applicationId,
      );
      const serviceMounts = deployable.mounts ?? [];

      expect(generateVolumeMounts(serviceMounts)).toEqual([
        { Type: 'volume', Source: 'blog-uploads', Target: '/app/uploads' },
      ]);
      expect(generateBindMounts(serviceMounts)).toEqual([
        { Type: 'bind', Source: '/var/data/blog', Target: '/app/data' },
      ]);
      expect(
        generateFileMounts(
          serviceMounts,
          fileMountsDirectoryOnRunServer(application.serverId, 'blog-app'),
        ),
      ).toEqual([
        {
          Type: 'bind',
          Source: `${filesOn(application.serverId, 'blog-app')}/config.json`,
          Target: '/app/config.json',
        },
      ]);
    });

    it('deploys a database with its mount rows alongside the data volume', async () => {
      const { ownerCtx, environment } = await setUpApplication();
      const database = await postgres.create(ownerCtx, {
        name: 'Main DB',
        appName: 'main-db',
        databaseName: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 'sup3rS3cret',
        environmentId: environment.environmentId,
      });

      await createMount(ownerCtx, {
        type: 'volume',
        volumeName: 'pg-backups',
        mountPath: '/backups',
        serviceType: 'postgres',
        serviceId: database.postgresId,
      });
      const fileMount = await createMount(ownerCtx, {
        type: 'file',
        filePath: 'init.sql',
        content: 'CREATE TABLE shop_items ();',
        mountPath: '/docker-entrypoint-initdb.d/init.sql',
        serviceType: 'postgres',
        serviceId: database.postgresId,
      });
      expect(fileMount.postgresId).toBe(database.postgresId);

      await postgres.deploy(ownerCtx, database.postgresId);

      expect(docker.createService).toHaveBeenCalledTimes(1);
      const [settings] = docker.createService.mock.lastCall as [
        {
          TaskTemplate: {
            ContainerSpec: {
              Mounts: { Type: string; Source: string; Target: string }[];
            };
          };
        },
      ];
      expect(settings.TaskTemplate.ContainerSpec.Mounts).toEqual([
        {
          Type: 'volume',
          Source: 'main-db-data',
          Target: '/var/lib/postgresql/18/docker',
        },
        { Type: 'volume', Source: 'pg-backups', Target: '/backups' },
        {
          Type: 'bind',
          Source: `${filesOn(database.serverId, 'main-db')}/init.sql`,
          Target: '/docker-entrypoint-initdb.d/init.sql',
        },
      ]);
    });
  });

  describe('update / remove / list', () => {
    it('updates a file mount and rewrites its file on the build server', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const created = await createMount(ownerCtx, {
        type: 'file',
        filePath: 'config.json',
        content: 'hello world',
        mountPath: '/app/config.json',
        serviceId: application.applicationId,
      });
      execMock.execAsync.mockClear();

      const updated = await mounts.update(ownerCtx, created.mountId, {
        content: 'hello again',
      });
      expect(updated).toMatchObject({
        mountId: created.mountId,
        content: 'hello again',
        filePath: 'config.json',
      });

      // 'hello again' lands in the same file, base64-encoded in transit.
      const files = filesOn(application.serverId, 'blog-app');
      expect(execMock.execAsync).toHaveBeenCalledWith(
        `${closeServiceDirectory(files)};\n` +
          `mkdir -p "${files}";\n` +
          'echo "aGVsbG8gYWdhaW4=" | base64 -d > ' +
          `"${files}/config.json";\n`,
      );
    });

    it('updates a volume mount without touching the build server', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const created = await createMount(ownerCtx, {
        type: 'volume',
        volumeName: 'blog-uploads',
        mountPath: '/app/uploads',
        serviceId: application.applicationId,
      });
      execMock.execAsync.mockClear();

      const updated = await mounts.update(ownerCtx, created.mountId, {
        mountPath: '/srv/uploads',
      });
      expect(updated).toMatchObject({
        volumeName: 'blog-uploads',
        mountPath: '/srv/uploads',
      });
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });

    it('removes a file mount deleting its file first', async () => {
      const { ownerCtx, application } = await setUpApplication();
      const created = await createMount(ownerCtx, {
        type: 'file',
        filePath: 'config.json',
        content: 'hello world',
        mountPath: '/app/config.json',
        serviceId: application.applicationId,
      });
      execMock.execAsync.mockClear();

      await mounts.remove(ownerCtx, created.mountId);
      // No double quotes around the path: it is an argv word now, so
      // `shell-quote` words it and a path with nothing to escape emits bare.
      // Those quotes were never the protection anyway — `$` and a backtick
      // substitute inside them — `resolveShellSafePath` is.
      expect(execMock.execAsync).toHaveBeenCalledWith(
        `rm -rf ${filesOn(application.serverId, 'blog-app')}/config.json`,
      );
      await expect(mounts.findOne(ownerCtx, created.mountId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lists the mounts of one service only', async () => {
      const { ownerCtx, application, environment } = await setUpApplication();
      const other = await applications.create(ownerCtx, {
        name: 'Shop',
        appName: 'shop-app',
        environmentId: environment.environmentId,
      });
      await createMount(ownerCtx, {
        type: 'volume',
        volumeName: 'blog-uploads',
        mountPath: '/app/uploads',
        serviceId: application.applicationId,
      });
      await createMount(ownerCtx, {
        type: 'bind',
        hostPath: '/var/data/blog',
        mountPath: '/app/data',
        serviceId: application.applicationId,
      });
      await createMount(ownerCtx, {
        type: 'volume',
        volumeName: 'shop-uploads',
        mountPath: '/app/uploads',
        serviceId: other.applicationId,
      });

      const listed = await mounts.listByService(ownerCtx, {
        serviceId: application.applicationId,
        serviceType: 'application',
      });
      expect(listed).toHaveLength(2);
      expect(listed.map((row) => row.type).sort()).toEqual(['bind', 'volume']);
    });
  });

  describe('row-level access', () => {
    it('denies a member without row access to the owning service', async () => {
      const { organizationId, ownerSession, ownerCtx, application } =
        await setUpApplication();
      const member = await inviteUser(
        server,
        ownerSession.cookie,
        'ida@example.com',
        'member',
      );
      const memberCtx = permissionCtx(member.id, organizationId);

      await expect(
        createMount(memberCtx, {
          type: 'volume',
          volumeName: 'blog-uploads',
          mountPath: '/app/uploads',
          serviceId: application.applicationId,
        }),
      ).rejects.toThrow(ForbiddenException);

      const created = await createMount(ownerCtx, {
        type: 'volume',
        volumeName: 'blog-uploads',
        mountPath: '/app/uploads',
        serviceId: application.applicationId,
      });
      await expect(mounts.findOne(memberCtx, created.mountId)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        mounts.update(memberCtx, created.mountId, { mountPath: '/srv' }),
      ).rejects.toThrow(ForbiddenException);
      await expect(mounts.remove(memberCtx, created.mountId)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        mounts.listByService(memberCtx, {
          serviceId: application.applicationId,
          serviceType: 'application',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('hides mounts and owning services from other organizations', async () => {
      const { ownerSession, ownerCtx, application } = await setUpApplication();
      const created = await createMount(ownerCtx, {
        type: 'volume',
        volumeName: 'blog-uploads',
        mountPath: '/app/uploads',
        serviceId: application.applicationId,
      });

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgCtx = permissionCtx(
        ownerSession.id,
        (secondOrg.body as { id: string }).id,
      );

      await expect(
        mounts.findOne(secondOrgCtx, created.mountId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        createMount(secondOrgCtx, {
          type: 'volume',
          volumeName: 'other',
          mountPath: '/data',
          serviceId: application.applicationId,
        }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        mounts.listByService(secondOrgCtx, {
          serviceId: application.applicationId,
          serviceType: 'application',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('HTTP surface', () => {
    it('creates, lists, updates and deletes a mount through the controller', async () => {
      const { ownerSession, application } = await setUpApplication();

      const invalid = await request(server)
        .post('/mounts')
        .set('Cookie', ownerSession.cookie)
        .send({ serviceId: application.applicationId, type: 'volume' });
      expect(invalid.status).toBe(400);

      const created = await request(server)
        .post('/mounts')
        .set('Cookie', ownerSession.cookie)
        .send({
          type: 'volume',
          volumeName: 'blog-uploads',
          mountPath: '/app/uploads',
          serviceId: application.applicationId,
        });
      expect(created.status).toBe(201);
      const { mountId } = created.body as { mountId: string };

      const listed = await request(server)
        .get('/mounts')
        .query({
          serviceId: application.applicationId,
          serviceType: 'application',
        })
        .set('Cookie', ownerSession.cookie);
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);

      const found = await request(server)
        .get(`/mounts/${mountId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(200);
      expect(found.body).toMatchObject({ volumeName: 'blog-uploads' });

      const updated = await request(server)
        .patch(`/mounts/${mountId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ mountPath: '/srv/uploads' });
      expect(updated.status).toBe(200);
      expect((updated.body as { mountPath: string }).mountPath).toBe(
        '/srv/uploads',
      );

      const removed = await request(server)
        .delete(`/mounts/${mountId}`)
        .set('Cookie', ownerSession.cookie);
      expect(removed.status).toBe(200);

      const gone = await request(server)
        .get(`/mounts/${mountId}`)
        .set('Cookie', ownerSession.cookie);
      expect(gone.status).toBe(404);
    });

    /**
     * The console's Edit dialog saves every kind of mount.
     *
     * Each body below is, key for key, what `mountsSpec`'s `update` sends for
     * that kind — `mounts-spec.test.tsx` pins the same literals from the other
     * side. The columns the kind does not own are *left out*: they used to go
     * as `""`, which `volumeNameSchema` and `filePathSchema` refuse, so all
     * three kinds answered 400 and the dialog could save none of them.
     */
    it.each([
      {
        kind: 'file',
        create: { filePath: 'app.conf', content: 'ui=1' },
        patch: {
          type: 'file',
          mountPath: '/etc/ui',
          filePath: 'app.conf',
          content: 'ui=2',
        },
        stored: { filePath: 'app.conf', content: 'ui=2' },
      },
      {
        kind: 'bind',
        create: { hostPath: '/srv/bind' },
        patch: { type: 'bind', mountPath: '/etc/ui', hostPath: '/srv/bind' },
        stored: { hostPath: '/srv/bind' },
      },
      {
        kind: 'volume',
        create: { volumeName: 'blog-uploads' },
        patch: {
          type: 'volume',
          mountPath: '/etc/ui',
          volumeName: 'blog-uploads',
        },
        stored: { volumeName: 'blog-uploads' },
      },
    ] as const)(
      "saves the console's edit of a $kind mount",
      async ({ kind, create, patch, stored }) => {
        const { ownerSession, application } = await setUpApplication();
        const created = await request(server)
          .post('/mounts')
          .set('Cookie', ownerSession.cookie)
          .send({
            type: kind,
            mountPath: '/etc/ui',
            serviceId: application.applicationId,
            ...create,
          });
        expect(created.status).toBe(201);
        const { mountId } = created.body as { mountId: string };
        execMock.execAsync.mockClear();

        const updated = await request(server)
          .patch(`/mounts/${mountId}`)
          .set('Cookie', ownerSession.cookie)
          .send(patch);

        expect(updated.status).toBe(200);
        expect(updated.body).toMatchObject(stored);
        if (kind === 'file') {
          // `ui=2`, base64-encoded, into the file the row names.
          expect(execMock.execAsync).toHaveBeenCalledWith(
            `${closeServiceDirectory(filesOn(application.serverId, 'blog-app'))};\n` +
              `mkdir -p "${filesOn(application.serverId, 'blog-app')}";\n` +
              'echo "dWk9Mg==" | base64 -d > ' +
              `"${filesOn(application.serverId, 'blog-app')}/app.conf";\n`,
          );
        }
      },
    );

    /**
     * The other half of the unused-columns fix: leaving the unused columns out is only safe
     * because a change of kind clears them here. A volume switched to a bind
     * kept `volume_name` beside its new `host_path` once already — the bug
     * `""` was chosen to fix — so the row claimed two sources.
     */
    it.each([
      {
        from: { type: 'volume', volumeName: 'blog-uploads' },
        to: { type: 'bind', hostPath: '/srv/bind' },
      },
      {
        from: { type: 'file', filePath: 'app.conf', content: 'secret=1' },
        to: { type: 'volume', volumeName: 'blog-uploads' },
      },
      {
        from: { type: 'bind', hostPath: '/srv/bind' },
        to: { type: 'file', filePath: 'app.conf', content: 'ui=1' },
      },
    ] as const)(
      "clears a $from.type mount's source when it becomes a $to.type",
      async ({ from, to }) => {
        const { ownerSession, application } = await setUpApplication();
        const created = await request(server)
          .post('/mounts')
          .set('Cookie', ownerSession.cookie)
          .send({
            ...from,
            mountPath: '/data',
            serviceId: application.applicationId,
          });
        expect(created.status).toBe(201);
        const { mountId } = created.body as { mountId: string };

        const updated = await request(server)
          .patch(`/mounts/${mountId}`)
          .set('Cookie', ownerSession.cookie)
          .send({ ...to, mountPath: '/data' });

        expect(updated.status).toBe(200);
        expect(updated.body).toEqual(
          expect.objectContaining({
            volumeName: null,
            hostPath: null,
            filePath: null,
            content: null,
            ...to,
          }),
        );
      },
    );

    /**
     * An earlier fix made `mountPath` optional — for `serviceType: 'compose'` only, whose
     * mount rows no deploy path ever assembles into a spec. The narrower
     * discriminant was the whole decision: `type === 'file'` would have let an
     * *application* file mount through with no container target, which stores
     * and then fails the deploy with a Docker error naming nothing, and
     * `generateFileMounts` reads `mountPath` on exactly that mount.
     *
     * `createMountSchema`'s own spec holds the rule; this pins that the loosened
     * field did not loosen the route, which is the acceptance shape the issue
     * asked for.
     */
    it('answers 400 for an application mount that names no mountPath', async () => {
      const { ownerSession, application } = await setUpApplication();

      const refused = await request(server)
        .post('/mounts')
        .set('Cookie', ownerSession.cookie)
        .send({
          type: 'file',
          filePath: 'config.json',
          content: 'hello world',
          serviceId: application.applicationId,
        });
      expect(refused.status).toBe(400);

      // Nothing was written on the way to being refused, and no row exists.
      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(await ctx.db.select().from(mount)).toHaveLength(0);
    });
  });
});
