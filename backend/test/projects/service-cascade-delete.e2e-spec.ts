import { NotFoundException } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { ComposeService } from '../../src/compose/compose.service';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import {
  application as applicationTable,
  compose as composeTable,
  environment as environmentTable,
  licenseKey,
  member,
  organizationRole,
  postgres as postgresTable,
  project as projectTable,
} from '../../src/db/schema';
import { applicationsDirectoryOn } from '../../src/deployment-engine/deployment-engine.paths';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
/**
 * The presence read the cascade issues per child — `docker service
 * inspect` for an Application and for all six database engines — and the
 * discriminator this file's exec mock recognises it by. Hand-written, and
 * imported from `test/utils/` rather than from
 * `application-ops.ts`/`database-ops.ts`: importing the product's builder would
 * make the test agree with whatever the builder says, and the shell trick these
 * commands turn on — exit 0 either way, the answer on stdout — is exactly the
 * thing a "simplification" would quietly drop.
 *
 * **Why one copy for the tree rather than this file's own.** This file used to
 * hold its own. H-95 changed the shape — `<question> && echo present || echo
 * absent` became `if ! <daemon>; then echo unknown; elif <question>; …`, so a
 * stopped daemon on a reachable Server stops reading as `absent` — and updated
 * the builder and its unit spec but not this copy. `isPresenceProbe` then
 * matched nothing, every probe answered `''`, `readWorkloadPresence` read that
 * as `'unknown'`, and **five tests in this file failed** (H-104), one of nine
 * suites it happened to. Independence from `src` is the property that earned the
 * copy its keep, and one copy preserves it exactly while making the next shape
 * change one file's edit rather than ten. Still run this file when the
 * probe changes — the unit spec passing is not evidence that this one does —
 * and the set-level guard in `test/common/workload-presence.spec.ts` is what
 * fails if the copy goes stale or an eleventh appears.
 */
import {
  isPresenceProbe,
  servicePresenceProbe,
} from '../utils/workload-presence-probe';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(180_000);

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

const ok = { stdout: '', stderr: '', exitCode: 0 };

/**
 * Deleting a Project or an Environment used to be one `db.delete` over an
 * `onDelete: 'cascade'` chain: every Application, compose stack and database
 * beneath it lost its row in one statement while every one of their workloads
 * kept running. Per ADR-0008 a container that resolves to no Service is
 * *unmanaged* and is reached through machine-level `docker:read`, so that
 * statement handed the whole tree to every organization on the host at once —
 * The cascade finding in bulk, by the path an operator is most likely to take.
 *
 * The seam is the same one the per-Service deletes are tested at: the exec
 * layer, the Traefik writer, and the rows left behind. Both roots live in one
 * file because they are one mechanism — `common/service-cascade.ts` — reached
 * from two services, and splitting them would duplicate the whole tree fixture
 * to assert the same three answers twice.
 */
describe('Project and Environment cascade delete (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;
  let compose: ComposeService;
  let postgresService: PostgresService;

  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<typeof ok>, [string]>(),
    execAsyncRemote: jest.fn<Promise<typeof ok>, [string, string]>(),
  });
  const traefikWriterMock = {
    loadOrCreateConfig: jest.fn(),
    writeConfig: jest.fn(),
    removeConfig: jest.fn(),
    writeCertificate: jest.fn(),
    removeCertificate: jest.fn(),
  };

  /**
   * The exec layer as the cascade's happy path sees it: every teardown succeeds
   * and every probe answers `absent`. A plain `mockResolvedValue(ok)` would
   * leave the probes answering an empty stdout — `'unknown'` on purpose, since
   * a shell that never ran the command is no more "gone" than a rejection is —
   * and every delete here would 409.
   */
  const teardownSucceeds = (command: string) =>
    Promise.resolve(
      isPresenceProbe(command) ? { ...ok, stdout: 'absent' } : ok,
    );

  /** Every shell command the cascade issued, local and remote, in order. */
  const executedCommands = (): string[] => [
    ...execMock.execAsync.mock.calls.map((call) => call[0]),
    ...execMock.execAsyncRemote.mock.calls.map((call) => call[1]),
  ];

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: TraefikWriterService, useValue: traefikWriterMock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
    compose = ctx.app.get(ComposeService);
    postgresService = ctx.app.get(PostgresService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();
    execMock.execAsync.mockImplementation(teardownSucceeds);
    execMock.execAsyncRemote.mockImplementation((_serverId, command) =>
      teardownSucceeds(command),
    );
    traefikWriterMock.removeConfig.mockResolvedValue(undefined);
  });

  /**
   * One Project, two Environments, and one Service of each kind under
   * `production` plus a second Application under `staging` — the tree the issue
   * describes, small enough to assert on by name.
   */
  async function setUpTree() {
    const ownerSession = await signUp(server, owner);
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', ownerSession.cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = permissionCtx(ownerSession.id, organizationId);

    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const production = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    const staging = await environments.create(ownerCtx, {
      name: 'staging',
      projectId: project.projectId,
    });

    const web = await applications.create(ownerCtx, {
      name: 'Web App',
      appName: 'web-app',
      environmentId: production.environmentId,
    });
    const stack = await compose.create(ownerCtx, {
      name: 'Wordpress',
      appName: 'wordpress',
      composeType: 'stack',
      environmentId: production.environmentId,
    });
    const database = await postgresService.create(ownerCtx, {
      name: 'Main DB',
      appName: 'main-db',
      databaseName: 'shop',
      databaseUser: 'shop',
      environmentId: production.environmentId,
    });
    const api = await applications.create(ownerCtx, {
      name: 'Api',
      appName: 'api-app',
      environmentId: staging.environmentId,
    });

    return {
      organizationId,
      ownerSession,
      ownerCtx,
      project,
      production,
      staging,
      web,
      stack,
      database,
      api,
    };
  }

  /**
   * A second member holding a licensed custom role that can delete a Project,
   * granted the Project and exactly `accessedServices` of its Services.
   *
   * A custom role rather than `member`, and it is the only way to reach the
   * behaviour: `project: ['delete']` is held by `owner` and `admin` alone, and
   * both skip every row-level check in `checkServiceAccess`, so a static role
   * cannot tell a per-child gate that refuses from one that never ran.
   */
  async function asDeployer(
    tree: {
      organizationId: string;
      ownerSession: { cookie: string };
      project: { projectId: string };
    },
    accessedServices: string[],
  ) {
    const invite = await request(server)
      .post('/organizations/invitations')
      .set('Cookie', tree.ownerSession.cookie)
      .send({ email: 'invitee@example.com', role: 'member' });
    const inviteId = (invite.body as { id: string }).id;
    const su = await request(server)
      .post('/api/auth/sign-up/email')
      .set('x-cloudgate-token', inviteId)
      .send({
        name: 'Ida Rhodes',
        email: 'invitee@example.com',
        password: 'super-secret-password',
      });
    const cookie = su.headers['set-cookie'];
    const userId = (su.body as { user: { id: string } }).user.id;
    await request(server)
      .post(`/organizations/invitations/${inviteId}/accept`)
      .set('Cookie', cookie);

    await ctx.db.insert(licenseKey).values({
      organizationId: tree.organizationId,
      key: 'test-license-key',
      status: 'active',
      enableEnterpriseFeatures: true,
    });
    await ctx.db.insert(organizationRole).values({
      organizationId: tree.organizationId,
      role: 'deployer',
      permission: {
        project: ['delete'],
        environment: ['read', 'delete'],
        service: ['read', 'delete'],
      },
    });
    await ctx.db
      .update(member)
      .set({
        role: 'deployer',
        // Granted the Project itself, so `findOne`'s row-level check passes and
        // the refusal below can only be the per-child one.
        accessedProjects: [tree.project.projectId],
        accessedServices,
      })
      .where(
        and(
          eq(member.userId, userId),
          eq(member.organizationId, tree.organizationId),
        ),
      );

    return { cookie, userId };
  }

  /** How many rows of each kind survive under this Project. */
  async function treeSize(projectId: string) {
    const environmentIds = (
      await ctx.db
        .select({ environmentId: environmentTable.environmentId })
        .from(environmentTable)
        .where(eq(environmentTable.projectId, projectId))
    ).map((row) => row.environmentId);
    if (environmentIds.length === 0) {
      return { environments: 0, applications: 0, compose: 0, postgres: 0 };
    }
    const [apps, stacks, databases] = await Promise.all([
      ctx.db
        .select()
        .from(applicationTable)
        .where(inArray(applicationTable.environmentId, environmentIds)),
      ctx.db
        .select()
        .from(composeTable)
        .where(inArray(composeTable.environmentId, environmentIds)),
      ctx.db
        .select()
        .from(postgresTable)
        .where(inArray(postgresTable.environmentId, environmentIds)),
    ]);
    return {
      environments: environmentIds.length,
      applications: apps.length,
      compose: stacks.length,
      postgres: databases.length,
    };
  }

  describe('deleting a Project', () => {
    it('tears every Service in the tree down and then deletes the tree', async () => {
      const { ownerSession, project } = await setUpTree();

      const res = await request(server)
        .delete(`/projects/${project.projectId}`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(200);
      const commands = executedCommands();
      expect(commands).toContain('docker service rm web-app');
      expect(commands).toContain('docker service rm api-app');
      expect(commands).toContain('docker service rm main-db');
      expect(commands).toContain(
        `rm -rf ${applicationsDirectoryOn(null)}/web-app`,
      );
      expect(
        commands.some((command) =>
          command.includes('docker stack rm wordpress'),
        ),
      ).toBe(true);
      // The dynamic-config files cascade nowhere; without these two calls the
      // delete leaves public hostnames routed at nothing.
      expect(traefikWriterMock.removeConfig).toHaveBeenCalledWith(
        'web-app',
        null,
      );
      expect(traefikWriterMock.removeConfig).toHaveBeenCalledWith(
        'api-app',
        null,
      );
      // Nothing to report: every workload was confirmed gone.
      expect(res.body).not.toHaveProperty('orphaned');

      expect(await treeSize(project.projectId)).toEqual({
        environments: 0,
        applications: 0,
        compose: 0,
        postgres: 0,
      });
    });

    it('still holds every row when the last presence read runs', async () => {
      const { ownerSession, project } = await setUpTree();
      const seenAtEachProbe: number[] = [];
      execMock.execAsync.mockImplementation(async (command) => {
        if (isPresenceProbe(command)) {
          // Read the target tables from inside the exec mock: a delete that
          // dropped the rows first and tore down afterwards — which is exactly
          // what this issue is about — would still pass every after-the-fact
          // assertion in this file.
          const size = await treeSize(project.projectId);
          seenAtEachProbe.push(
            size.applications + size.compose + size.postgres,
          );
        }
        return teardownSucceeds(command);
      });

      const res = await request(server)
        .delete(`/projects/${project.projectId}`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(200);
      // Five probes for four children: the compose child is asked **both**
      // compose questions, because choosing one by its `composeType` made this
      // cascade's safety property depend on a column a caller can `PATCH`
      // (H-87). What the numbers say is the point — all four rows still there at
      // every one of them.
      expect(seenAtEachProbe).toHaveLength(5);
      expect(seenAtEachProbe).toEqual([4, 4, 4, 4, 4]);
    });

    /**
     * H-105, at the wire and on the real clock.
     *
     * The cascade read compose presence *immediately* after
     * `composeTeardownCommand`, exactly as `ComposeService.remove` did before
     * H-99. `docker stack rm` returns as soon as the daemon accepts the removal
     * while `docker stack ps --quiet` keeps naming tasks in `Shutdown` for 6–7 s
     * after it, so a Project with a `stack` child 409'd on the first attempt
     * every time — 409 at t+0, 409 at t+3, 200 at t+6/t+7 on the X-run host, 3
     * trials of 3 — and under `?force=true` named that child as `orphaned` when
     * it was merely still draining. `remove()` waited and the cascade did not,
     * about a property the per-Service delete owns.
     *
     * No settle clock is stubbed here on purpose: nothing overrides
     * `COMPOSE_SETTLE_CLOCK` for this route, so what runs is the production
     * default and the one poll costs one real second. The bounded-deadline
     * arithmetic — one window for the whole cascade, a spent deadline still
     * refusing, `unknown` never re-asked — is in `test/common/service-cascade.spec.ts`,
     * where a fake clock can exhaust fifteen seconds in microseconds.
     */
    it('deletes the Project on the first attempt when a compose stack is still draining', async () => {
      const { ownerSession, project } = await setUpTree();
      let composeProbes = 0;
      execMock.execAsync.mockImplementation((command) => {
        if (isPresenceProbe(command) && command.includes('wordpress')) {
          composeProbes += 1;
          // Both questions per round (H-87), so `present` for the first round
          // and `absent` from the second is one stack that drained.
          return Promise.resolve({
            ...ok,
            stdout: composeProbes <= 2 ? 'present' : 'absent',
          });
        }
        return teardownSucceeds(command);
      });

      const res = await request(server)
        .delete(`/projects/${project.projectId}`)
        .set('Cookie', ownerSession.cookie);

      // Pre-fix: 409, with a refusal whose first instruction — *stop them, then
      // delete again* — named the action this request had already performed.
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('orphaned');
      // Re-asked rather than assumed: two rounds of both questions. The answer
      // is still the probe's own — nothing here synthesizes `absent`.
      expect(composeProbes).toBe(4);
      expect(await treeSize(project.projectId)).toEqual({
        environments: 0,
        applications: 0,
        compose: 0,
        postgres: 0,
      });
    });

    it('refuses the delete and keeps the whole tree when one workload is still running', async () => {
      const { ownerSession, project } = await setUpTree();
      execMock.execAsync.mockImplementation((command) => {
        if (command === 'docker service rm main-db') {
          return Promise.reject(new Error('service removal failed'));
        }
        if (command === servicePresenceProbe('main-db')) {
          return Promise.resolve({ ...ok, stdout: 'present\n' });
        }
        return teardownSucceeds(command);
      });

      const res = await request(server)
        .delete(`/projects/${project.projectId}`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toContain('main-db');

      // No partial delete: the three Services whose teardown *did* succeed keep
      // their rows too. Dropping them would orphan nothing today, but it would
      // leave an operator holding half a Project they cannot reason about, and
      // the retry would have nothing left to tear down.
      expect(await treeSize(project.projectId)).toEqual({
        environments: 2,
        applications: 2,
        compose: 1,
        postgres: 1,
      });
      const found = await request(server)
        .get(`/projects/${project.projectId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(200);
    });

    it('refuses when a Server cannot be reached, and force deletes while naming every workload left behind', async () => {
      const { ownerSession, project } = await setUpTree();
      execMock.execAsync.mockRejectedValue(new Error('ssh: connect refused'));

      const refused = await request(server)
        .delete(`/projects/${project.projectId}`)
        .set('Cookie', ownerSession.cookie);

      expect(refused.status).toBe(409);
      // 'unknown', not 'gone': an unreachable daemon is the case where treating
      // a failure as absence is what manufactures the orphan.
      expect((refused.body as { message: string }).message).toContain(
        '?force=true',
      );
      expect(await treeSize(project.projectId)).toMatchObject({
        applications: 2,
        compose: 1,
        postgres: 1,
      });

      const forced = await request(server)
        .delete(`/projects/${project.projectId}?force=true`)
        .set('Cookie', ownerSession.cookie);

      expect(forced.status).toBe(200);
      // The answer says what was left behind rather than a bare 200 claiming
      // four workloads are gone when nobody established that.
      expect((forced.body as { orphaned: unknown[] }).orphaned).toEqual(
        expect.arrayContaining([
          { appName: 'web-app', serverId: null, reason: 'unknown' },
          { appName: 'api-app', serverId: null, reason: 'unknown' },
          { appName: 'wordpress', serverId: null, reason: 'unknown' },
          { appName: 'main-db', serverId: null, reason: 'unknown' },
        ]),
      );
      expect(await treeSize(project.projectId)).toEqual({
        environments: 0,
        applications: 0,
        compose: 0,
        postgres: 0,
      });
      expect(
        await ctx.db
          .select()
          .from(projectTable)
          .where(eq(projectTable.projectId, project.projectId)),
      ).toHaveLength(0);
    });

    it('deletes a Project with no Services without reaching a daemon', async () => {
      const ownerSession = await signUp(server, owner);
      const orgs = await request(server)
        .get('/organizations')
        .set('Cookie', ownerSession.cookie);
      const organizationId = (orgs.body as { id: string }[])[0].id;
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const project = await projects.create(ownerCtx, { name: 'empty' });
      await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });

      const res = await request(server)
        .delete(`/projects/${project.projectId}`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(200);
      expect(executedCommands()).toEqual([]);
    });

    it('refuses a caller granted only some of the Services, before anything is torn down', async () => {
      const tree = await setUpTree();
      const deployer = await asDeployer(tree, [tree.web.applicationId]);

      const res = await request(server)
        .delete(`/projects/${tree.project.projectId}`)
        .set('Cookie', deployer.cookie);

      expect(res.status).toBe(403);
      // Not one command. Every child is access-checked before the first
      // teardown, or the route stays what it was — a way to destroy Services
      // whose own DELETE route refuses you, and a way to make Docker calls you
      // are not entitled to.
      expect(executedCommands()).toEqual([]);
      expect(await treeSize(tree.project.projectId)).toMatchObject({
        applications: 2,
        compose: 1,
        postgres: 1,
      });
    });

    it('lets the same caller through once every Service is granted', async () => {
      const tree = await setUpTree();
      const deployer = await asDeployer(tree, [
        tree.web.applicationId,
        tree.api.applicationId,
        tree.stack.composeId,
        tree.database.postgresId,
      ]);

      const res = await request(server)
        .delete(`/projects/${tree.project.projectId}`)
        .set('Cookie', deployer.cookie);

      // The pair that proves the refusal above is the per-child check refusing
      // rather than the route being closed to this role altogether.
      expect(res.status).toBe(200);
      expect(await treeSize(tree.project.projectId)).toEqual({
        environments: 0,
        applications: 0,
        compose: 0,
        postgres: 0,
      });
    });

    it('reads a Project in another organization as absent without reaching a daemon', async () => {
      const { ownerSession, project } = await setUpTree();
      const second = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgCtx = permissionCtx(
        ownerSession.id,
        (second.body as { id: string }).id,
      );

      await expect(
        projects.remove(secondOrgCtx, project.projectId),
      ).rejects.toThrow(NotFoundException);

      // The org scope is resolved before the tree is enumerated, so a Project
      // that reads as absent never has its Services touched.
      expect(executedCommands()).toEqual([]);
      expect(await treeSize(project.projectId)).toMatchObject({
        applications: 2,
      });
    });
  });

  describe('deleting an Environment', () => {
    it('tears down only the Services in that Environment and leaves its siblings running', async () => {
      const { ownerSession, project, production } = await setUpTree();

      const res = await request(server)
        .delete(`/environments/${production.environmentId}`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(200);
      const commands = executedCommands();
      expect(commands).toContain('docker service rm web-app');
      expect(commands).toContain('docker service rm main-db');
      // `staging`'s Application is not this Environment's to tear down.
      expect(commands).not.toContain('docker service rm api-app');
      expect(traefikWriterMock.removeConfig).not.toHaveBeenCalledWith(
        'api-app',
        null,
      );

      expect(await treeSize(project.projectId)).toEqual({
        environments: 1,
        applications: 1,
        compose: 0,
        postgres: 0,
      });
    });

    it('refuses the delete and keeps the Environment when a workload is still running', async () => {
      const { ownerSession, project, production } = await setUpTree();
      execMock.execAsync.mockImplementation((command) => {
        if (command === servicePresenceProbe('web-app')) {
          return Promise.resolve({ ...ok, stdout: 'present\n' });
        }
        return teardownSucceeds(command);
      });

      const res = await request(server)
        .delete(`/environments/${production.environmentId}`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toContain('web-app');
      expect((res.body as { message: string }).message).toContain('production');

      expect(await treeSize(project.projectId)).toEqual({
        environments: 2,
        applications: 2,
        compose: 1,
        postgres: 1,
      });
      const found = await request(server)
        .get(`/environments/${production.environmentId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(200);
    });

    it('forces the delete and names the workload it left behind', async () => {
      const { ownerSession, project, production } = await setUpTree();
      execMock.execAsync.mockImplementation((command) => {
        if (command === servicePresenceProbe('web-app')) {
          return Promise.resolve({ ...ok, stdout: 'present\n' });
        }
        return teardownSucceeds(command);
      });

      const res = await request(server)
        .delete(`/environments/${production.environmentId}?force=true`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        orphaned: [{ appName: 'web-app', serverId: null, reason: 'present' }],
      });
      expect(await treeSize(project.projectId)).toEqual({
        environments: 1,
        applications: 1,
        compose: 0,
        postgres: 0,
      });
    });
  });
});
