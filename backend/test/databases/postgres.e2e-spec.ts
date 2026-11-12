import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import {
  postgres as postgresTable,
  server as serverTable,
} from '../../src/db/schema';
import { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { IMAGE_REFERENCE_MESSAGE } from '../../src/registries/dto/registry.dto';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { expectQuotedInCommand, SHELL_PAYLOAD } from '../utils/shell-safety';
import { createTestApp, TestAppContext } from '../utils/test-app';
/**
 * The presence read Delete issues — every database engine's is
 * `docker service inspect`, via `BaseDatabaseService.remove` — and the
 * discriminator this file's exec mock recognises it by. Hand-written, and
 * imported from `test/utils/` rather than from `database-ops.ts`: importing the
 * product's builder would make the test agree with whatever the builder says,
 * and the shell trick this command turns on — exit 0 either way, the answer on
 * stdout — is exactly the thing a "simplification" would quietly drop.
 *
 * **Why one copy for the tree rather than this file's own.** This file used to
 * hold its own. H-95 changed the shape — `<question> && echo present || echo
 * absent` became `if ! <daemon>; then echo unknown; elif <question>; …`, so a
 * stopped daemon on a reachable Server stops reading as `absent` — and updated
 * the builder and its unit spec but not this copy. The two
 * `startsWith('docker service inspect ')` discriminators that used to live here
 * then matched nothing, the probe answered `''`, `readWorkloadPresence` read
 * that as `'unknown'`, and **the happy-path delete in this file 409'd**
 * (H-104), one of nine suites it happened to. Independence from `src` is the
 * property that earned the copy its keep, and one copy preserves it exactly
 * while making the next shape change one file's edit rather than ten.
 * Still run this file when the probe changes — the unit spec passing is not
 * evidence that this one does — and the set-level guard in
 * `test/common/workload-presence.spec.ts` is what fails if the copy goes stale
 * or an eleventh appears.
 */
import {
  isPresenceProbe,
  servicePresenceProbe,
  volumePresenceProbe,
} from '../utils/workload-presence-probe';
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

describe('Postgres (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let postgresService: PostgresService;

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
    postgresService = ctx.app.get(PostgresService);
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
      .post('/postgres')
      .set('Cookie', cookie)
      .send({
        name: 'Main DB',
        appName: 'main-db',
        databaseName: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 'sup3rS3cret',
        environmentId,
        ...overrides,
      });
    expect(created.status).toBe(201);
    return created.body as { postgresId: string; appName: string };
  }

  describe('create', () => {
    it('creates a postgres database retrievable with its connection info', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();

      const created = await request(server)
        .post('/postgres')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Main DB',
          appName: 'main-db',
          databaseName: 'shop',
          databaseUser: 'shop_user',
          databasePassword: 'sup3rS3cret',
          environmentId,
        });
      expect(created.status).toBe(201);
      const { postgresId } = created.body as { postgresId: string };
      expect(postgresId).toEqual(expect.any(String));

      const found = await request(server)
        .get(`/postgres/${postgresId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(200);
      // The connection info a client needs to reach the database.
      expect(found.body).toMatchObject({
        postgresId,
        name: 'Main DB',
        appName: 'main-db',
        databaseName: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 'sup3rS3cret',
        dockerImage: 'postgres:18',
        applicationStatus: 'idle',
        externalPort: null,
        environmentId,
      });
    });

    it('rejects a password with shell-dangerous characters', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();

      const created = await request(server)
        .post('/postgres')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Main DB',
          databaseName: 'shop',
          databaseUser: 'shop_user',
          databasePassword: 'un$afe pa$$word!',
          environmentId,
        });
      expect(created.status).toBe(400);
    });

    it('generates a password when none is supplied', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();

      const created = await request(server)
        .post('/postgres')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Main DB',
          databaseName: 'shop',
          databaseUser: 'shop_user',
          environmentId,
        });
      expect(created.status).toBe(201);
      const { databasePassword } = created.body as { databasePassword: string };
      expect(databasePassword).toMatch(/^[a-z0-9]{16}$/);
    });

    it('stores the password encrypted at rest', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();

      const created = await request(server)
        .post('/postgres')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Main DB',
          databaseName: 'shop',
          databaseUser: 'shop_user',
          databasePassword: 'sup3rS3cret',
          environmentId,
        });
      expect(created.status).toBe(201);

      // Read the raw column, bypassing the decrypting column type.
      const raw = await ctx.db.execute<{ database_password: string }>(
        sql`select database_password from postgres`,
      );
      expect(raw.rows).toHaveLength(1);
      expect(raw.rows[0].database_password).not.toContain('sup3rS3cret');
    });

    /**
     * The representative for the shared base. All six engines' `create`
     * is a two-line delegation to `BaseDatabaseService.createDatabase`, so this
     * is one insertion point covering `/postgres`, `/mysql`, `/mariadb`,
     * `/mongo`, `/redis` and `/libsql`; the other five are driven over HTTP by
     * `test/servers/create-routes-server-id.e2e-spec.ts` rather than repeated
     * here. Before the fix `serverId` was swallowed by `createDatabase`'s
     * `Record<string, unknown>` and went straight to the foreign key, which
     * answered 500 — and, naming no organization column, could not have
     * refused another organization's Server at all.
     */
    it('refuses a serverId in another organization with 404 rather than inserting', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();

      // A real row in a second organization, not an id nothing owns: one
      // lookup raises the same NotFound whichever predicate misses.
      const other = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'other-tenant', slug: `other-${Date.now()}` },
      );
      const [theirs] = await ctx.db
        .insert(serverTable)
        .values({
          name: 'not-yours',
          ipAddress: '203.0.113.31',
          port: 22,
          organizationId: (other.body as { id: string }).id,
        })
        .returning();

      const refused = await request(server)
        .post('/postgres')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Main DB',
          appName: 'main-db',
          databaseName: 'shop',
          databaseUser: 'shop_user',
          environmentId,
          serverId: theirs.serverId,
        });

      expect(refused.status).toBe(404);
      expect((refused.body as { message: string }).message).toBe(
        'Server not found',
      );
      const rows = await ctx.db.execute(sql`select 1 from postgres`);
      expect(rows.rows).toHaveLength(0);
    });
  });

  describe('deploy', () => {
    it('pulls the image and creates the service with image, POSTGRES_* env and data volume', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const deployed = await request(server)
        .post(`/postgres/${postgresId}/deploy`)
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
      expectQuotedInCommand(pull ?? null, 'postgres:18');

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
      expect(settings.TaskTemplate.ContainerSpec.Image).toBe('postgres:18');
      expect(settings.TaskTemplate.ContainerSpec.Env).toEqual(
        expect.arrayContaining([
          'POSTGRES_DB=shop',
          'POSTGRES_USER=shop_user',
          'POSTGRES_PASSWORD=sup3rS3cret',
        ]),
      );
      // Postgres 18+ keeps PGDATA under /var/lib/postgresql/{version}/docker.
      expect(settings.TaskTemplate.ContainerSpec.Mounts).toEqual([
        {
          Type: 'volume',
          Source: 'main-db-data',
          Target: '/var/lib/postgresql/18/docker',
        },
      ]);
      // No external port yet: nothing published.
      expect(settings.EndpointSpec).toEqual({ Mode: 'dnsrr', Ports: [] });

      const found = await request(server)
        .get(`/postgres/${postgresId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'done' });
    });

    it('mounts the data volume at the classic PGDATA for images before 18', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
        { dockerImage: 'postgres:16' },
      );

      await request(server)
        .post(`/postgres/${postgresId}/deploy`)
        .set('Cookie', ownerSession.cookie);

      const [settings] = docker.createService.mock.lastCall as [
        {
          TaskTemplate: { ContainerSpec: { Mounts: { Target: string }[] } };
        },
      ];
      expect(settings.TaskTemplate.ContainerSpec.Mounts[0].Target).toBe(
        '/var/lib/postgresql/data',
      );
    });

    /**
     * The inertness finding, at the route — **and the assertion H-53 changed**.
     *
     * It used to expect the `PATCH` to answer **200**, and said why: *"the
     * decision for this column was quote, not refuse, because an image
     * reference is user-meaningful — a 400 here would be the wrong fix
     * passing."* That reasoning was sound about the *sink* and wrong about the
     * *column*. An image reference being user-meaningful is an argument for
     * transcribing `distribution/reference` instead of inventing a
     * metacharacter blocklist; it is not an argument for the column having no
     * grammar at all, and `postgres:18a$(id)` is not an image reference under
     * anyone's reading — no registry could ever serve it. H-53 gave all six
     * engines `databaseImageSchema`, so the refusal is now the correct
     * expectation and the 200 was encoding the gap.
     *
     * What the two halves pin is deliberately unchanged in substance: the
     * refusal is asserted *as a refusal* — the grammar's own message, the row
     * still carrying the image it had, and no `docker pull` on the wire at all
     * — and the inertness claim survives below on the only precondition that
     * still reaches it.
     */
    it('refuses a dockerImage that is not an image reference, and stores nothing', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const patched = await request(server)
        .patch(`/postgres/${postgresId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ dockerImage: `postgres:18${SHELL_PAYLOAD}` });

      expect(patched.status).toBe(400);
      // The grammar's own message, not merely "not 200": a 400 from the
      // permission gate, the parent lookup or a neighbouring field would
      // satisfy a bare status check and prove nothing about this column.
      expect(JSON.stringify(patched.body)).toContain(IMAGE_REFERENCE_MESSAGE);

      // Nothing was stored on the way to being refused.
      const found = await request(server)
        .get(`/postgres/${postgresId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ dockerImage: 'postgres:18' });

      // And the payload never reached the wire: a later deploy asks for the
      // image the row still has. Asserted on the argv seam rather than on the
      // worded string, because `quote()` renders `postgres:18` as
      // `postgres\:18` and a string comparison would be pinning `shell-quote`'s
      // escaping scheme rather than which image was pulled.
      //
      // No `mockClear()` before the deploy, and its absence is the load-bearing
      // part: this line used to be `execMock.execFileAsync.mockClear()` because
      // the `beforeEach` above resets the two *string* mocks this file declares
      // and `withArgvExec` adds the argv pair afterwards, so the argv record ran
      // the whole file and an exact-list assertion had no way to say which calls
      // it meant. `withArgvExec` clears them itself now (H-65), so the list below
      // is this test's calls because the harness says so rather than because this
      // test remembered to ask.
      const deployed = await request(server)
        .post(`/postgres/${postgresId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      expect(deployed.status).toBe(200);
      const pulls = (
        execMock.execFileAsync.mock.calls as [string, string[]][]
      ).filter(([program, args]) => program === 'docker' && args[0] === 'pull');
      expect(pulls).toEqual([['docker', ['pull', 'postgres:18']]]);
    });

    /**
     * The inertness claim, on the precondition that outlives the
     * DTO rule: a **row already carrying the word**.
     *
     * The value is written straight onto the row rather than through the route,
     * which is not a way around the schema but the shape the schema cannot
     * reach — the same argument `git-providers/strategies/docker.strategy.ts`
     * makes for keeping its `shEscape` after H-47. Rows written before H-53 are
     * in the database unrevalidated, a `.partial()` PATCH that omits the column
     * never parses it, and `deployInternal` reads the row rather than a body.
     * So the charset is what makes the column mean something and the argv is
     * what makes the command safe, and this pins the second one.
     *
     * The assertion is a `shell-quote` parse rather than a literal comparison,
     * so it pins the outcome and not the escaping scheme
     * (`test/utils/shell-safety.ts`); `execOnServer` reaches
     * `execFileAsync`/`execRemote` and `withArgvExec` words the argv
     * the way the service does.
     */
    it('pulls a stored dockerImage carrying a metacharacter as one inert word', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      await ctx.db
        .update(postgresTable)
        .set({ dockerImage: `postgres:18${SHELL_PAYLOAD}` })
        .where(eq(postgresTable.postgresId, postgresId));

      const deployed = await request(server)
        .post(`/postgres/${postgresId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      expect(deployed.status).toBe(200);

      const pull = execMock.execAsync.mock.calls
        .map(([command]: [string]) => command)
        .find((command: string) => command.startsWith('docker pull'));
      expectQuotedInCommand(pull ?? null, `postgres:18${SHELL_PAYLOAD}`);
    });

    it('a failed deploy leaves the database in error status', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      execMock.execAsync.mockRejectedValue(new Error('pull failed'));

      const deployed = await request(server)
        .post(`/postgres/${postgresId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      // A Docker failure is a 409 naming what Docker said, not a bare 500.
      expect(deployed.status).toBe(409);
      expect((deployed.body as { message: string }).message).toContain(
        'pull failed',
      );

      const found = await request(server)
        .get(`/postgres/${postgresId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'error' });
      expect(docker.createService).not.toHaveBeenCalled();
    });
  });

  describe('status change', () => {
    it('start scales the service up and marks the database done', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const started = await request(server)
        .post(`/postgres/${postgresId}/start`)
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
        .get(`/postgres/${postgresId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'done' });
    });

    it('stop scales the service to zero and marks the database stopped, which a never-deployed row cannot be', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      // The control, read before the stop rather than spelled as a literal:
      // the whole property is that the two are not the same word, and a test
      // that wrote `'idle'` twice would still pass if the column's default
      // moved onto the stop status and collapsed them again.
      const neverDeployed = (
        await request(server)
          .get(`/postgres/${postgresId}`)
          .set('Cookie', ownerSession.cookie)
      ).body as { applicationStatus: string };
      expect(neverDeployed.applicationStatus).toBe('idle');

      const stopped = await request(server)
        .post(`/postgres/${postgresId}/stop`)
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
        .get(`/postgres/${postgresId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'stopped' });
      expect(
        (found.body as { applicationStatus: string }).applicationStatus,
      ).not.toBe(neverDeployed.applicationStatus);
    });
  });

  describe('external port', () => {
    it('saving an external port redeploys with the port published', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const saved = await request(server)
        .post(`/postgres/${postgresId}/external-port`)
        .set('Cookie', ownerSession.cookie)
        .send({ externalPort: 5433 });
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
            TargetPort: 5432,
            PublishedPort: 5433,
            PublishMode: 'host',
          },
        ],
      });

      const found = await request(server)
        .get(`/postgres/${postgresId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ externalPort: 5433 });
    });

    it('clearing the external port unpublishes it on the next converge', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      await request(server)
        .post(`/postgres/${postgresId}/external-port`)
        .set('Cookie', ownerSession.cookie)
        .send({ externalPort: 5433 });

      const cleared = await request(server)
        .post(`/postgres/${postgresId}/external-port`)
        .set('Cookie', ownerSession.cookie)
        .send({ externalPort: null });
      expect(cleared.status).toBe(200);

      const [settings] = docker.createService.mock.lastCall as [
        { EndpointSpec: { Mode: string; Ports: unknown[] } },
      ];
      expect(settings.EndpointSpec).toEqual({ Mode: 'dnsrr', Ports: [] });
    });

    /**
     * The save converged at `replicas`, the configured count a Stop does
     * not touch, so publishing a port brought a stopped database back up. It
     * now writes the spec with no tasks, so the port is on the service for the
     * next Start — which only scales — and the row still reads `stopped`.
     */
    it('saving an external port on a stopped database publishes it for the next start without starting it', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      const stopped = await request(server)
        .post(`/postgres/${postgresId}/stop`)
        .set('Cookie', ownerSession.cookie);
      expect(stopped.status).toBe(200);

      const saved = await request(server)
        .post(`/postgres/${postgresId}/external-port`)
        .set('Cookie', ownerSession.cookie)
        .send({ externalPort: 5433 });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({
        applicationStatus: 'stopped',
        externalPort: 5433,
      });

      expect(docker.createService).toHaveBeenCalledTimes(1);
      const [settings] = docker.createService.mock.lastCall as [
        {
          Mode: { Replicated: { Replicas: number } };
          EndpointSpec: { Ports: { PublishedPort: number }[] };
        },
      ];
      expect(settings.Mode).toEqual({ Replicated: { Replicas: 0 } });
      expect(settings.EndpointSpec.Ports).toEqual([
        expect.objectContaining({ TargetPort: 5432, PublishedPort: 5433 }),
      ]);

      const found = await request(server)
        .get(`/postgres/${postgresId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'stopped' });
    });

    it('an explicit Deploy of a stopped database still starts it', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      await request(server)
        .post(`/postgres/${postgresId}/stop`)
        .set('Cookie', ownerSession.cookie);

      const deployed = await request(server)
        .post(`/postgres/${postgresId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      expect(deployed.status).toBe(200);
      expect(deployed.body).toMatchObject({ applicationStatus: 'done' });

      const [settings] = docker.createService.mock.lastCall as [
        { Mode: { Replicated: { Replicas: number } } },
      ];
      expect(settings.Mode).toEqual({ Replicated: { Replicas: 1 } });
    });
  });

  describe('rebuild', () => {
    it('removes the service and its data volume, then re-creates the service', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      await request(server)
        .post(`/postgres/${postgresId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      docker.createService.mockClear();
      execMock.execAsync.mockClear();

      const rebuilt = await request(server)
        .post(`/postgres/${postgresId}/rebuild`)
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
        .get(`/postgres/${postgresId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'done' });
    });
  });

  describe('update, environment and status parity', () => {
    it('updates config and saves env vars that feed the next deploy', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const updated = await request(server)
        .patch(`/postgres/${postgresId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'Renamed DB', memoryLimit: '268435456' });
      expect(updated.status).toBe(200);

      const savedEnv = await request(server)
        .patch(`/postgres/${postgresId}/environment`)
        .set('Cookie', ownerSession.cookie)
        .send({ env: 'PGTZ=UTC' });
      expect(savedEnv.status).toBe(200);

      await request(server)
        .post(`/postgres/${postgresId}/deploy`)
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
        expect.arrayContaining(['POSTGRES_DB=shop', 'PGTZ=UTC']),
      );
      expect(settings.TaskTemplate.Resources.Limits.MemoryBytes).toBe(
        268435456,
      );

      const found = await request(server)
        .get(`/postgres/${postgresId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ name: 'Renamed DB' });
    });

    it('changeStatus sets the status directly', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const changed = await request(server)
        .post(`/postgres/${postgresId}/status`)
        .set('Cookie', ownerSession.cookie)
        .send({ applicationStatus: 'error' });
      expect(changed.status).toBe(200);

      const found = await request(server)
        .get(`/postgres/${postgresId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.body).toMatchObject({ applicationStatus: 'error' });
    });
  });

  /**
   * The container's own environment, which is the only
   * assertion that decides either of them. A DTO that accepts a value and a
   * row that stores it say nothing about which credential the server enforces;
   * `ContainerSpec.Env` is where that is settled, so every test here reads the
   * `createService` call and not the response body.
   *
   * The representative for the shared base and for the other five engines:
   * `BaseDatabaseService.deployInternal` is one method, and
   * `test/databases/reserved-env.spec.ts` holds the per-engine halves.
   */
  describe("the platform's own environment", () => {
    /** The `Env` of the service the last deploy converged. */
    function deployedEnv(): string[] {
      const [settings] = docker.createService.mock.lastCall as [
        { TaskTemplate: { ContainerSpec: { Env: string[] } } },
      ];
      return settings.TaskTemplate.ContainerSpec.Env;
    }

    it('gives the container the stored password even when the row env assigns POSTGRES_PASSWORD', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      // Written straight to the column, which is what a row saved *before*
      // this rule looks like: the write path refuses this body now (the test
      // below), and the deploy still has to be right for the rows that got in.
      await ctx.db
        .update(postgresTable)
        .set({ env: 'POSTGRES_PASSWORD=other\nPGTZ=UTC' })
        .where(eq(postgresTable.postgresId, postgresId));

      const deployed = await request(server)
        .post(`/postgres/${postgresId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      expect(deployed.status).toBe(200);

      const env = deployedEnv();
      // `sup3rS3cret` is what `GET /postgres/:id` answers and what every
      // connection string Cloudgate builds is made of, so it is what the
      // server has to want. `other` used to be the one that took effect.
      expect(env).toContain('POSTGRES_PASSWORD=sup3rS3cret');
      expect(env).not.toContain('POSTGRES_PASSWORD=other');
      // The operator's non-colliding variable is untouched: the platform wins
      // its own names and nothing else.
      expect(env).toContain('PGTZ=UTC');
    });

    it('refuses a row env that assigns one of the platform’s own names, naming the column that owns it', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      const refused = await request(server)
        .patch(`/postgres/${postgresId}/environment`)
        .set('Cookie', ownerSession.cookie)
        .send({ env: 'POSTGRES_PASSWORD=other' });
      expect(refused.status).toBe(400);
      const body = JSON.stringify(refused.body);
      expect(body).toContain('POSTGRES_PASSWORD');
      expect(body).toContain('databasePassword');

      // An image variable the platform does not emit is still the operator's.
      const ordinary = await request(server)
        .patch(`/postgres/${postgresId}/environment`)
        .set('Cookie', ownerSession.cookie)
        .send({ env: 'POSTGRES_HOST_AUTH_METHOD=scram-sha-256' });
      expect(ordinary.status).toBe(200);
    });

    /**
     * Item 2, and the ticket's own shape of it does not reproduce — see
     * `test/databases/reserved-env.spec.ts` for the measurement. What is
     * reachable is worse: a `"` plus a newline in `databaseName` closes
     * `defaultEnv`'s quoted value and the rest of the column becomes *further
     * dotenv lines*, so the operator writes keys into
     * `ContainerSpec.Env` that no engine emits and nobody assigned.
     * `POSTGRES_HOST_AUTH_METHOD=trust` is the one that matters: on a fresh
     * volume it makes the server accept any password at all.
     *
     * The create route refuses such a name, which takes it as an
     * unquoted identifier, so the hostile value is written straight to the
     * column, the shape of a row saved before that rule: the deploy still
     * has to be right for the rows that got in.
     */
    it('puts a hostile databaseName in the container verbatim and injects nothing', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const databaseName = 'shop"\nPOSTGRES_HOST_AUTH_METHOD=trust\n"x';
      const refused = await request(server)
        .post('/postgres')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Hostile DB',
          databaseName,
          databaseUser: 'shop_user',
          databasePassword: 'sup3rS3cret',
          environmentId,
        });
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain('databaseName');

      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      await ctx.db
        .update(postgresTable)
        .set({ databaseName })
        .where(eq(postgresTable.postgresId, postgresId));

      const deployed = await request(server)
        .post(`/postgres/${postgresId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      expect(deployed.status).toBe(200);

      const env = deployedEnv();
      expect(env).toContain(`POSTGRES_DB=${databaseName}`);
      expect(env.map((pair) => pair.split('=')[0])).not.toContain(
        'POSTGRES_HOST_AUTH_METHOD',
      );
      // And the value the container gets is the value the row holds, rather
      // than the truncation the old quoting produced.
      const found = await request(server)
        .get(`/postgres/${postgresId}`)
        .set('Cookie', ownerSession.cookie);
      expect((found.body as { databaseName: string }).databaseName).toBe(
        databaseName,
      );
    });

    it('keeps a databaseName carrying a quote and a comment marker exact', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      // `POSTGRES_DB="a"b#c"` parsed back as `"a"b` — a stray quote kept and
      // the tail dropped, which is the lossy shape the ticket was reaching for.
      // Written to the column, as above: create refuses it.
      const databaseName = 'a"b#c';
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      await ctx.db
        .update(postgresTable)
        .set({ databaseName })
        .where(eq(postgresTable.postgresId, postgresId));

      await request(server)
        .post(`/postgres/${postgresId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      expect(deployedEnv()).toContain(`POSTGRES_DB=${databaseName}`);
    });
  });

  describe('remove', () => {
    it('removes the swarm service and the row', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      await request(server)
        .post(`/postgres/${postgresId}/deploy`)
        .set('Cookie', ownerSession.cookie);
      execMock.execAsync.mockClear();

      const removed = await request(server)
        .delete(`/postgres/${postgresId}`)
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
        .get(`/postgres/${postgresId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(404);
    });

    /**
     * Whether `<appName>-data` survived is the Server's to say, read
     * after the teardown with the same three-valued probe as the service: the
     * console states a left-behind volume, or that nothing is left, only on a
     * definite answer.
     */
    it('answers whether the data volume was left behind', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      execMock.execAsync.mockImplementation((command: string) =>
        command === volumePresenceProbe('main-db-data')
          ? Promise.resolve({ stdout: 'present\n', stderr: '' })
          : teardownSucceeds(command),
      );

      const removed = await request(server)
        .delete(`/postgres/${postgresId}`)
        .set('Cookie', ownerSession.cookie);
      expect(removed.status).toBe(200);
      expect(removed.body).toMatchObject({ volumeLeftBehind: true });
    });

    it('GET :id/volume answers whether the data volume is on the Server before the delete', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );

      execMock.execAsync.mockImplementation((command: string) =>
        command === volumePresenceProbe('main-db-data')
          ? Promise.resolve({ stdout: 'present\n', stderr: '' })
          : teardownSucceeds(command),
      );
      const present = await request(server)
        .get(`/postgres/${postgresId}/volume`)
        .set('Cookie', ownerSession.cookie);
      expect(present.status).toBe(200);
      expect(present.body).toEqual({ present: true });

      execMock.execAsync.mockImplementation(teardownSucceeds);
      const absent = await request(server)
        .get(`/postgres/${postgresId}/volume`)
        .set('Cookie', ownerSession.cookie);
      expect(absent.body).toEqual({ present: false });

      execMock.execAsync.mockRejectedValue(new Error('ssh: connect refused'));
      const unreadable = await request(server)
        .get(`/postgres/${postgresId}/volume`)
        .set('Cookie', ownerSession.cookie);
      expect(unreadable.body).toEqual({ present: null });

      // A read, not the delete: the row is still there.
      expect(
        (
          await request(server)
            .get(`/postgres/${postgresId}`)
            .set('Cookie', ownerSession.cookie)
        ).status,
      ).toBe(200);
    });

    it('answers no volume when the Server positively has none — a database never deployed', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      execMock.execAsync.mockImplementation(teardownSucceeds);

      const removed = await request(server)
        .delete(`/postgres/${postgresId}`)
        .set('Cookie', ownerSession.cookie);
      expect(removed.status).toBe(200);
      expect(removed.body).toMatchObject({ volumeLeftBehind: false });
    });

    /**
     * The sibling half of the cascade fix. The teardown was already in the right
     * order here; what was wrong was that its failure was swallowed and the row went anyway
     * — "a dead server must not make deletion impossible". The verification
     * host caught exactly that: a `postgres-i6xyp8` still `Up` twenty-four
     * hours after its row was deleted, carrying only
     * `com.docker.swarm.service.name`, and therefore *unmanaged* — listed to
     * and actable by all six organizations on the box, four of which had never
     * created a database. The row is the only handle the product has, so it now
     * survives a teardown that cannot be confirmed.
     *
     * The representative for the shared base: all six engines' `remove` is
     * `BaseDatabaseService.remove`.
     */
    it('refuses the delete and keeps the row when the swarm service is still there', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      execMock.execAsync.mockImplementation((command: string) => {
        if (command.includes('docker service rm')) {
          return Promise.reject(new Error('service removal failed'));
        }
        // The exact program, not a prefix: this arm is the one that has to
        // answer `present`, and a discriminator that matched the *question*
        // rather than the whole probe is what H-104 was.
        if (command === servicePresenceProbe('main-db')) {
          return Promise.resolve({ stdout: 'present\n', stderr: '' });
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      });

      const refused = await request(server)
        .delete(`/postgres/${postgresId}`)
        .set('Cookie', ownerSession.cookie);
      expect(refused.status).toBe(409);
      expect((refused.body as { message: string }).message).toContain(
        'main-db',
      );

      // Still addressable through the product, which is the whole point: the
      // row is what lets anyone stop or delete the workload at all.
      const found = await request(server)
        .get(`/postgres/${postgresId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(200);
    });

    it('refuses when Docker cannot be reached, and force deletes while reporting what was left', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
        ownerSession.cookie,
        environmentId,
      );
      execMock.execAsync.mockRejectedValue(new Error('ssh: connect refused'));

      const refused = await request(server)
        .delete(`/postgres/${postgresId}`)
        .set('Cookie', ownerSession.cookie);
      expect(refused.status).toBe(409);
      expect((refused.body as { message: string }).message).toContain(
        '?force=true',
      );
      expect(
        (
          await request(server)
            .get(`/postgres/${postgresId}`)
            .set('Cookie', ownerSession.cookie)
        ).status,
      ).toBe(200);

      // The escape hatch the old swallowed catch existed for, kept — but as a
      // deliberate act with a truthful answer.
      const forced = await request(server)
        .delete(`/postgres/${postgresId}?force=true`)
        .set('Cookie', ownerSession.cookie);
      expect(forced.status).toBe(200);
      expect(forced.body).toMatchObject({
        orphaned: { appName: 'main-db', serverId: null, reason: 'unknown' },
        // Nothing could be read, so nothing is claimed either way.
        volumeLeftBehind: null,
      });
      expect(
        (
          await request(server)
            .get(`/postgres/${postgresId}`)
            .set('Cookie', ownerSession.cookie)
        ).status,
      ).toBe(404);
    });
  });

  describe('row-level access', () => {
    it('a member without a row-level grant can neither read nor operate', async () => {
      const { ownerSession, organizationId, environmentId } =
        await setUpEnvironment();
      const { postgresId } = await createDatabase(
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

      await expect(
        postgresService.findOne(inviteeCtx, postgresId),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        postgresService.deploy(inviteeCtx, postgresId),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        postgresService.start(inviteeCtx, postgresId),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        postgresService.rebuild(inviteeCtx, postgresId),
      ).rejects.toThrow(ForbiddenException);
      // The Delete dialog's volume read is guarded as the Delete is.
      await expect(
        postgresService.dataVolume(inviteeCtx, postgresId),
      ).rejects.toThrow(ForbiddenException);

      // And over HTTP the same wall: 403, and nothing converged.
      const denied = await request(server)
        .post(`/postgres/${postgresId}/deploy`)
        .set('Cookie', invitee.cookie);
      expect(denied.status).toBe(403);
      expect(docker.createService).not.toHaveBeenCalled();
    });

    it('databases are invisible outside their own organization', async () => {
      const { ownerSession, environmentId } = await setUpEnvironment();
      const { postgresId } = await createDatabase(
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
        postgresService.findOne(secondOrgCtx, postgresId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        postgresService.deploy(secondOrgCtx, postgresId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        postgresService.rebuild(secondOrgCtx, postgresId),
      ).rejects.toThrow(NotFoundException);
      expect(docker.createService).not.toHaveBeenCalled();
    });
  });
});
