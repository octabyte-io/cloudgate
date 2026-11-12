import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  destination,
  licenseKey,
  member,
  organizationRole,
  volumeBackup,
} from '../../src/db/schema';
import { cloudgateDirectoryOn } from '../../src/common/config/cloudgate-directory';
import { ExecError } from '../../src/remote/exec-error';
import { ComposeService } from '../../src/compose/compose.service';
import {
  COMPOSE_SETTLE_BUDGET_MS,
  COMPOSE_SETTLE_CLOCK,
} from '../../src/compose/compose.utils';
import type { SettleClock } from '../../src/compose/compose.utils';
import { DeploymentEngineService } from '../../src/deployment-engine/deployment-engine.service';
import { DEPLOYMENT_QUEUE } from '../../src/deployment-queue/queue.port';
import { DomainsService } from '../../src/domains/domains.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { expectQuotedInCommand, SHELL_PAYLOAD } from '../utils/shell-safety';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import {
  composeProjectPresenceProbe,
  isPresenceProbe,
  stackPresenceProbe,
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

/** The owner's bootstrap organization plus a service-seam permission ctx. */
async function setUpOwner(server: App) {
  const ownerSession = await signUp(server, owner);

  const orgs = await request(server)
    .get('/organizations')
    .set('Cookie', ownerSession.cookie);
  const organizationId = (orgs.body as { id: string }[])[0].id;

  return { organizationId, owner: ownerSession };
}

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

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

const ok = { stdout: '', stderr: '', exitCode: 0 };

/**
 * The root of every path this file asserts, taken from the machine the path is
 * on. Every stack here is created with no Server, so it is deployed,
 * started, locked and torn down on the **platform host** (`serverId: null`,
 * ADR-0008) by this process's own exec — and its tree is under this process's
 * `CLOUDGATE_DIRECTORY`.
 *
 * These were written `/etc/cloudgate/…`, which is a *Server's* root, and were
 * green only because the platform host's root is that same string until an
 * operator sets the variable. The tail under the root stays a literal rather
 * than `composeDirectoryOn`/`logsDirectoryOn`, for the reason `presenceProbe`
 * below is hand-written: an expectation rebuilt the way the code builds it
 * agrees with whatever the code says (§1.7). A function rather than a constant
 * for `localCloudgateDirectory`'s reason — the root is read when asked, not at
 * import.
 */
const platformRoot = () => cloudgateDirectoryOn(null);

/** A literal string as a `RegExp` source, for a root spliced into a pattern. */
const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The delete path's settle poll clock (H-99), as the seam it exists to be: it
 * advances only by its own sleeps, so a test can exhaust the whole
 * fifteen-second window in microseconds rather than in fifteen seconds. The
 * production binding in `ComposeModule` is the system clock.
 */
const settleSleeps: number[] = [];
let settleElapsedMs = 0;
const settleClock: SettleClock = {
  now: () => settleElapsedMs,
  sleep: (ms) => {
    settleSleeps.push(ms);
    settleElapsedMs += ms;
    return Promise.resolve();
  },
};

/**
 * The presence read Delete issues, one per compose type — a swarm stack
 * and a compose project are two different questions, and Delete issues
 * **both**: the `composeType` argument here is only this file's way of naming
 * one of them, because choosing between them by the row's stored type was H-87,
 * that column being `PATCH`-able.
 *
 * The two programs and the discriminator come from
 * `test/utils/workload-presence-probe.ts`, which is hand-written and imports
 * nothing from `src`, for the reason its docblock gives: importing
 * `compose.utils.ts`'s builder would make the test agree with whatever the
 * builder says, and the shell trick these commands turn on (exit 0 either way,
 * the answer on stdout) is exactly the thing a "simplification" would quietly
 * drop.
 *
 * **Why one copy for the tree rather than this file's own.** This file used to
 * hold its own. H-95 changed the shape — `<question> && echo present || echo
 * absent` became `if ! <daemon>; then echo unknown; elif <question>; …` — and
 * updated the builder and its unit spec but not this copy, so `isPresenceProbe`
 * stopped matching anything, every probe answered `''`, `readWorkloadPresence`
 * read that as `'unknown'`, and **five deletes in this file 409'd**: this suite
 * was red on `main` from `84a1dcb` until it was noticed while fixing H-98/H-99,
 * one of nine suites it happened to. Independence from `src` is the property
 * that earned the copy its keep, and one copy preserves it exactly while making
 * the next shape change one file's edit rather than ten. Still run this
 * file when the probe changes: the unit spec passing is not evidence that this
 * one does, and the set-level guard in
 * `test/common/workload-presence.spec.ts` is what fails if the copy goes stale
 * or an eleventh appears.
 */
const presenceProbe = (
  appName: string,
  composeType: 'docker-compose' | 'stack' = 'docker-compose',
) =>
  composeType === 'stack'
    ? stackPresenceProbe(appName)
    : composeProjectPresenceProbe(appName);

/**
 * The exec layer as Delete sees it by default: every command succeeds and the
 * presence read says the stack's workload is gone, which is the happy path. A
 * plain `mockResolvedValue({ stdout: '', … })` would leave the probe answering
 * an empty stdout — `'unknown'`, deliberately, because a shell that never ran
 * the command is no more "gone" than a rejection is — and every delete in this
 * file would 409.
 */
const teardownSucceeds = (command: string) =>
  Promise.resolve(isPresenceProbe(command) ? { ...ok, stdout: 'absent' } : ok);

const WORDPRESS_COMPOSE = `services:
  wordpress:
    image: wordpress:6
    ports:
      - "8080:80"
  db:
    image: mariadb:11
`;

describe('Compose (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let compose: ComposeService;
  let domains: DomainsService;
  let engine: DeploymentEngineService;

  const execMock = withArgvExec({
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  });
  const queueMock = {
    add: jest.fn(),
    getJobs: jest.fn(),
    cancel: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: DEPLOYMENT_QUEUE, useValue: queueMock },
        { provide: COMPOSE_SETTLE_CLOCK, useValue: settleClock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    compose = ctx.app.get(ComposeService);
    domains = ctx.app.get(DomainsService);
    engine = ctx.app.get(DeploymentEngineService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    // Delete verifies the stack's containers are really gone before it drops
    // the row, so the presence read has to answer. Everything else is
    // unchanged: `teardownSucceeds` resolves `ok` for every other command.
    execMock.execAsync.mockReset().mockImplementation(teardownSucceeds);
    execMock.execAsyncRemote
      .mockReset()
      .mockImplementation((_serverId: string, command: string) =>
        teardownSucceeds(command),
      );
    settleSleeps.length = 0;
    settleElapsedMs = 0;
    queueMock.add.mockReset().mockResolvedValue({ id: 'job-1' });
    queueMock.getJobs.mockReset().mockResolvedValue([]);
    queueMock.cancel.mockReset().mockResolvedValue(false);
  });

  /** Every shell command the mocked exec saw, local and remote. */
  const executedCommands = (): string[] => [
    ...execMock.execAsync.mock.calls.map(
      (call: unknown[]) => call[0] as string,
    ),
    ...execMock.execAsyncRemote.mock.calls.map(
      (call: unknown[]) => call[1] as string,
    ),
  ];

  /** The content of every `base64 -d` write in the given commands, in order. */
  const decodedWrites = (commands: string[]): string[] =>
    commands.flatMap((command) =>
      [...command.matchAll(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/g)].map(
        (match) => Buffer.from(match[1], 'base64').toString('utf-8'),
      ),
    );

  /** An owner ctx plus a project + environment for compose stacks to attach to. */
  async function setUpEnvironment(name = 'cloudgate') {
    const { organizationId, owner: ownerSession } = await setUpOwner(server);
    const ownerCtx = permissionCtx(ownerSession.id, organizationId);
    const project = await projects.create(ownerCtx, { name });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    return { organizationId, ownerSession, ownerCtx, project, environment };
  }

  describe('create → findOne', () => {
    it('creates a compose stack retrievable with its environment relations', async () => {
      const { ownerCtx, project, environment } = await setUpEnvironment();

      const created = await compose.create(ownerCtx, {
        name: 'Wordpress',
        appName: 'wordpress-stack',
        description: 'blog stack',
        environmentId: environment.environmentId,
        composeFile: WORDPRESS_COMPOSE,
      });

      expect(created.composeId).toEqual(expect.any(String));
      expect(created.appName).toBe('wordpress-stack');
      expect(created.composeStatus).toBe('idle');
      // #1338: a create with a pasted file and no `sourceType` is `raw`. It
      // was the column's `github`, which the deploy then refused.
      expect(created.sourceType).toBe('raw');
      expect(created.composeType).toBe('docker-compose');
      expect(created.composePath).toBe('./docker-compose.yml');
      expect(created.isolatedDeployment).toBe(false);

      const found = await compose.findOne(ownerCtx, created.composeId);
      expect(found).toMatchObject({
        composeId: created.composeId,
        name: 'Wordpress',
        description: 'blog stack',
        composeFile: WORDPRESS_COMPOSE,
        environmentId: environment.environmentId,
      });
      expect(found.environment.projectId).toBe(project.projectId);
      expect(found.environment.project.projectId).toBe(project.projectId);
    });

    /**
     * #1338. `POST /compose` took a `composeFile` and no `sourceType`, so a
     * stack created with a pasted file was stored `github`, refused at deploy
     * with "no source is chosen", and its file never read.
     */
    describe('the source a create stores', () => {
      const post = (cookie: string, body: Record<string, unknown>) =>
        request(server).post('/compose').set('Cookie', cookie).send(body);

      it('stores raw for a pasted file with no sourceType, and deploys that file', async () => {
        const { ownerSession, environment } = await setUpEnvironment();

        const created = await post(ownerSession.cookie, {
          name: 'Wordpress',
          appName: 'wp-stack',
          environmentId: environment.environmentId,
          composeFile: WORDPRESS_COMPOSE,
        });
        expect(created.status).toBe(201);
        const { composeId, sourceType } = created.body as {
          composeId: string;
          sourceType: string;
        };
        expect(sourceType).toBe('raw');

        // One request, no `PATCH`: the deploy is not refused and materializes
        // the pasted file rather than cloning a repository.
        const deployable = await compose.findDeployable(composeId);
        await engine.deployCompose(deployable, {
          title: 'Manual deployment',
          description: '',
        });
        const commands = executedCommands();
        expect(decodedWrites(commands)[0]).toContain('image: wordpress:6');
        expect(commands.some((c) => c.includes('git clone'))).toBe(false);
      });

      it('stores github, the column default, when no file is given', async () => {
        const { ownerSession, environment } = await setUpEnvironment();

        // What the console's "From a repository" create sends.
        for (const composeFile of [undefined, '']) {
          const created = await post(ownerSession.cookie, {
            name: 'From a repository',
            environmentId: environment.environmentId,
            ...(composeFile === undefined ? {} : { composeFile }),
          });
          expect(created.status).toBe(201);
          expect((created.body as { sourceType: string }).sourceType).toBe(
            'github',
          );
        }
      });

      it('stores the sourceType given, whatever the file', async () => {
        const { ownerSession, environment } = await setUpEnvironment();

        const gitea = await post(ownerSession.cookie, {
          name: 'Gitea',
          environmentId: environment.environmentId,
          composeFile: WORDPRESS_COMPOSE,
          sourceType: 'gitea',
        });
        expect(gitea.status).toBe(201);
        expect((gitea.body as { sourceType: string }).sourceType).toBe('gitea');

        // The console's "A file written here": raw before a file is written.
        const raw = await post(ownerSession.cookie, {
          name: 'Written here',
          environmentId: environment.environmentId,
          composeFile: '',
          sourceType: 'raw',
        });
        expect(raw.status).toBe(201);
        expect((raw.body as { sourceType: string }).sourceType).toBe('raw');
      });

      it('refuses a sourceType a Compose stack cannot have', async () => {
        const { ownerSession, environment } = await setUpEnvironment();

        const refused = await post(ownerSession.cookie, {
          name: 'Dropped',
          environmentId: environment.environmentId,
          sourceType: 'drop',
        });
        expect(refused.status).toBe(400);
      });
    });

    it('generates a valid appName when none is given', async () => {
      const { ownerCtx, environment } = await setUpEnvironment();

      const created = await compose.create(ownerCtx, {
        name: 'Unnamed',
        environmentId: environment.environmentId,
      });

      expect(created.appName).toMatch(/^compose-[a-z0-9._-]+$/);
      expect(created.composeFile).toBe('');
    });

    it('stores env encrypted at rest, returned decrypted', async () => {
      const { ownerCtx, environment } = await setUpEnvironment();

      const created = await compose.create(ownerCtx, {
        name: 'Secretive',
        environmentId: environment.environmentId,
      });

      await compose.saveEnvironment(ownerCtx, created.composeId, {
        env: 'DB_PASSWORD=super-secret',
      });

      const found = await compose.findOne(ownerCtx, created.composeId);
      expect(found.env).toBe('DB_PASSWORD=super-secret');

      const raw = await ctx.db.$client.query<{ env: string }>(
        'select env from compose where compose_id = $1',
        [created.composeId],
      );
      expect(raw.rows[0].env).not.toContain('super-secret');
      expect(raw.rows[0].env.startsWith('enc:v1:')).toBe(true);
    });

    it('stores the deploy-webhook secret encrypted at rest, returned decrypted', async () => {
      const { ownerCtx, environment } = await setUpEnvironment();

      const created = await compose.create(ownerCtx, {
        name: 'Triggerable',
        environmentId: environment.environmentId,
      });

      // The deploy-webhook fix was filed against `application.refreshToken` and
      // did not mention Compose, which carries the identical column — and the
      // wider blast radius, since one webhook redeploys every service in the
      // file.
      expect(created.refreshToken).toBeTruthy();
      const raw = await ctx.db.$client.query<{ refresh_token: string }>(
        'select refresh_token from compose where compose_id = $1',
        [created.composeId],
      );
      expect(raw.rows[0].refresh_token).not.toBe(created.refreshToken);
      expect(raw.rows[0].refresh_token.startsWith('enc:v1:')).toBe(true);

      const found = await compose.findOne(ownerCtx, created.composeId);
      expect(found.refreshToken).toBe(created.refreshToken);
    });

    it('rejects a duplicate appName', async () => {
      const { ownerCtx, environment } = await setUpEnvironment();

      await compose.create(ownerCtx, {
        name: 'First',
        appName: 'taken-name',
        environmentId: environment.environmentId,
      });

      await expect(
        compose.create(ownerCtx, {
          name: 'Second',
          appName: 'taken-name',
          environmentId: environment.environmentId,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('update', () => {
    it('changes the given fields and leaves the rest untouched', async () => {
      const { ownerCtx, environment } = await setUpEnvironment();

      const created = await compose.create(ownerCtx, {
        name: 'before',
        appName: 'stable-name',
        environmentId: environment.environmentId,
      });
      await compose.saveEnvironment(ownerCtx, created.composeId, {
        env: 'API_KEY=untouched',
      });

      const updated = await compose.update(ownerCtx, created.composeId, {
        name: 'after',
        composeType: 'stack',
        sourceType: 'git',
        customGitUrl: 'https://git.example.com/blog.git',
        customGitBranch: 'main',
        composePath: './deploy/compose.yaml',
        isolatedDeployment: true,
      });
      expect(updated).toMatchObject({
        composeId: created.composeId,
        name: 'after',
        appName: 'stable-name',
        composeType: 'stack',
        sourceType: 'git',
        customGitUrl: 'https://git.example.com/blog.git',
        customGitBranch: 'main',
        composePath: './deploy/compose.yaml',
        isolatedDeployment: true,
      });

      const found = await compose.findOne(ownerCtx, created.composeId);
      expect(found.name).toBe('after');
      expect(found.env).toBe('API_KEY=untouched');
      expect(found.appName).toBe('stable-name');
    });
  });

  describe('remove', () => {
    it('deletes the compose stack', async () => {
      const { ownerCtx, environment } = await setUpEnvironment();

      const created = await compose.create(ownerCtx, {
        name: 'doomed',
        environmentId: environment.environmentId,
      });

      const removed = await compose.remove(ownerCtx, created.composeId);
      expect(removed.composeId).toBe(created.composeId);

      await expect(
        compose.findOne(ownerCtx, created.composeId),
      ).rejects.toThrow(NotFoundException);
    });

    it('removing the parent environment cascades its compose stacks', async () => {
      const { ownerCtx, environment } = await setUpEnvironment();

      const created = await compose.create(ownerCtx, {
        name: 'cascaded',
        environmentId: environment.environmentId,
      });

      await environments.remove(ownerCtx, environment.environmentId);

      const raw = await ctx.db.$client.query(
        'select compose_id from compose where compose_id = $1',
        [created.composeId],
      );
      expect(raw.rows).toEqual([]);
    });
  });

  describe('permissions and isolation', () => {
    it('a member without a row-level grant cannot read a compose stack in their own organization', async () => {
      const { ownerSession, ownerCtx, organizationId, environment } =
        await setUpEnvironment();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      const inviteeCtx = permissionCtx(invitee.id, organizationId);

      const created = await compose.create(ownerCtx, {
        name: 'ungranted',
        environmentId: environment.environmentId,
      });

      await expect(
        compose.findOne(inviteeCtx, created.composeId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('a member cannot create a compose stack', async () => {
      const { ownerSession, organizationId, environment } =
        await setUpEnvironment();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      const inviteeCtx = permissionCtx(invitee.id, organizationId);

      await expect(
        compose.create(inviteeCtx, {
          name: 'not-allowed',
          environmentId: environment.environmentId,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('a compose stack is invisible outside its own organization', async () => {
      const { ownerSession } = await setUpEnvironment();

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;

      const secondOrgCtx = permissionCtx(ownerSession.id, secondOrgId);
      const orgBProject = await projects.create(secondOrgCtx, {
        name: 'org-b',
      });
      const orgBEnv = await environments.create(secondOrgCtx, {
        name: 'org-b-only',
        projectId: orgBProject.projectId,
      });
      const orgBCompose = await compose.create(secondOrgCtx, {
        name: 'org-b-compose',
        environmentId: orgBEnv.environmentId,
      });

      // Same user, but acting in the first organization: the compose stack
      // from the second organization must not resolve, even for its creator.
      const firstOrg = await request(server)
        .get('/organizations')
        .set('Cookie', ownerSession.cookie);
      const firstOrgId = (firstOrg.body as { id: string }[]).find(
        (o) => o.id !== secondOrgId,
      )!.id;
      const firstOrgCtx = permissionCtx(ownerSession.id, firstOrgId);

      await expect(
        compose.findOne(firstOrgCtx, orgBCompose.composeId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        compose.create(firstOrgCtx, {
          name: 'cross-org-create',
          environmentId: orgBEnv.environmentId,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('HTTP endpoint surface', () => {
    it('supports the full CRUD round-trip over HTTP', async () => {
      const { ownerSession, environment } = await setUpEnvironment();
      const cookie = ownerSession.cookie;

      const created = await request(server)
        .post('/compose')
        .set('Cookie', cookie)
        .send({
          name: 'blog',
          appName: 'blog-over-http',
          environmentId: environment.environmentId,
          composeFile: WORDPRESS_COMPOSE,
        });
      expect(created.status).toBe(201);
      const id = (created.body as { composeId: string }).composeId;

      const one = await request(server)
        .get(`/compose/${id}`)
        .set('Cookie', cookie);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        name: 'blog',
        appName: 'blog-over-http',
        composeFile: WORDPRESS_COMPOSE,
      });

      const patched = await request(server)
        .patch(`/compose/${id}`)
        .set('Cookie', cookie)
        .send({ name: 'blog-renamed', composeType: 'stack' });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        name: 'blog-renamed',
        composeType: 'stack',
      });

      const savedEnv = await request(server)
        .patch(`/compose/${id}/environment`)
        .set('Cookie', cookie)
        .send({ env: 'A=1' });
      expect(savedEnv.status).toBe(200);
      expect(savedEnv.body).toMatchObject({ env: 'A=1' });

      const removed = await request(server)
        .delete(`/compose/${id}`)
        .set('Cookie', cookie);
      expect(removed.status).toBe(200);

      const gone = await request(server)
        .get(`/compose/${id}`)
        .set('Cookie', cookie);
      expect(gone.status).toBe(404);
    });

    it('POST /compose returns 403 for a member and 201 for the owner', async () => {
      const { ownerSession, environment } = await setUpEnvironment();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );

      const denied = await request(server)
        .post('/compose')
        .set('Cookie', invitee.cookie)
        .send({
          name: 'not-allowed',
          environmentId: environment.environmentId,
        });
      expect(denied.status).toBe(403);

      const allowed = await request(server)
        .post('/compose')
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'allowed', environmentId: environment.environmentId });
      expect(allowed.status).toBe(201);
      expect(allowed.body).toMatchObject({ name: 'allowed' });
    });
  });

  /** A raw-source compose stack ready to deploy. */
  async function setUpRawCompose() {
    const env = await setUpEnvironment();
    const created = await compose.create(env.ownerCtx, {
      name: 'Wordpress',
      appName: 'wp-stack',
      environmentId: env.environment.environmentId,
      composeFile: WORDPRESS_COMPOSE,
    });
    await compose.update(env.ownerCtx, created.composeId, {
      sourceType: 'raw',
    });
    return { ...env, created };
  }

  describe('deploy', () => {
    it('records a pending deployment and enqueues a compose job over HTTP', async () => {
      const { ownerSession, created } = await setUpRawCompose();

      const res = await request(server)
        .post(`/compose/${created.composeId}/deployments`)
        .set('Cookie', ownerSession.cookie)
        .send({ title: 'Ship it', description: 'first deploy' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        composeId: created.composeId,
        title: 'Ship it',
        status: 'pending',
      });

      expect(queueMock.add).toHaveBeenCalledTimes(1);
      expect(queueMock.add).toHaveBeenCalledWith({
        applicationType: 'compose',
        composeId: created.composeId,
        // The row it just recorded, which the build claims.
        deploymentId: (res.body as { deploymentId: string }).deploymentId,
        title: 'Ship it',
        description: 'first deploy',
        type: 'deploy',
        serverId: null,
      });

      const history = await request(server)
        .get(`/compose/${created.composeId}/deployments`)
        .set('Cookie', ownerSession.cookie);
      expect(history.status).toBe(200);
      expect(history.body).toHaveLength(1);
      expect((history.body as { status: string }[])[0]).toMatchObject({
        status: 'pending',
      });
    });

    it('deployCompose materializes the raw file, runs the build under env -i and flips statuses to done', async () => {
      const { ownerCtx, created } = await setUpRawCompose();

      // As the queue processor would, once the job reaches the worker.
      const deployable = await compose.findDeployable(created.composeId);
      await engine.deployCompose(deployable, {
        title: 'Manual deployment',
        description: '',
      });

      const commands = executedCommands();
      // Clone step: the raw strategy materializes the stored compose file —
      // already converted, so the file on the target is the one the
      // build is about to apply rather than the pre-injection stored one.
      const cloneWrite = decodedWrites(commands)[0];
      expect(cloneWrite).toContain('image: wordpress:6');
      expect(cloneWrite).toContain('cloudgate-network');
      // Build step: compose up under env -i, piped into the deployment log.
      const build = commands.find((c) =>
        c.includes('up -d --build --remove-orphans'),
      );
      expect(build).toBeDefined();
      expect(build).toContain(
        'env -i PATH="$PATH" HOME="$HOME" docker compose -p wp-stack',
      );
      expect(build).toMatch(
        new RegExp(
          `>> ${escapeRegExp(platformRoot())}/logs/wp-stack/.+\\.log 2>&1`,
        ),
      );

      const found = await compose.findOne(ownerCtx, created.composeId);
      expect(found.composeStatus).toBe('done');
    });

    // The clone step is `rm -rf <dir>` followed by a base64 write, and
    // domain injection used to run after it — so a deploy that failed on
    // injection had already replaced the file the running containers were
    // built from. Nothing may be written until the conversion has succeeded.
    it('writes nothing to the deploy target when domain injection refuses the file', async () => {
      const { ownerCtx, created } = await setUpRawCompose();
      await domains.create(ownerCtx, {
        host: 'nope.example.com',
        composeId: created.composeId,
        serviceName: 'ghost',
        domainType: 'compose',
      });

      const deployable = await compose.findDeployable(created.composeId);
      await expect(
        engine.deployCompose(deployable, {
          title: 'Manual deployment',
          description: '',
        }),
      ).rejects.toThrow(
        'Domain "nope.example.com" is attached to service "ghost" which does not exist in the compose file',
      );

      // The only exec that ran is the one that appends the refusal to the log.
      const commands = executedCommands();
      expect(commands.some((c) => c.includes('rm -rf'))).toBe(false);
      expect(commands.some((c) => c.includes('docker-compose.yml'))).toBe(
        false,
      );
      expect(commands.some((c) => c.includes('Error occurred'))).toBe(true);

      // …and the status is the `idle` the stack was created with, not `error`:
      // an attempt that changed nothing may not report damage. The
      // decisive version of this — refused from `done`, where `error` would
      // actually have overwritten something — is
      // `test/deployment-engine/deployment-engine.e2e-spec.ts`.
      const found = await compose.findOne(ownerCtx, created.composeId);
      expect(found.composeStatus).toBe('idle');
    });

    it('converts the raw file in the clone step, so the file on the target carries the router labels before the build runs', async () => {
      const { ownerCtx, created } = await setUpRawCompose();
      const domain = await domains.create(ownerCtx, {
        host: 'shop.example.com',
        composeId: created.composeId,
        serviceName: 'wordpress',
        domainType: 'compose',
      });

      const deployable = await compose.findDeployable(created.composeId);
      await engine.deployCompose(deployable, {
        title: 'Manual deployment',
        description: '',
      });

      const writes = decodedWrites(executedCommands());
      expect(writes[0]).toContain(
        `traefik.http.routers.wp-stack-${domain.uniqueConfigKey}-web.rule=Host(\`shop.example.com\`)`,
      );
      // …and injecting again in the build step does not double the labels.
      const buildWrite = writes.find(
        (write, index) => index > 0 && write.includes('traefik.enable=true'),
      );
      expect(buildWrite).toBeDefined();
      expect(buildWrite?.match(/traefik\.enable=true/g)).toHaveLength(1);
      expect(buildWrite).toBe(writes[0]);
    });

    /**
     * The `composePath` traversal's write half, through the deploy that
     * performs it.
     *
     * `getComposeFilePath` has six callers in `src/` and three of them
     * **write** — `getBuildComposeCommand`'s domain-injected compose file,
     * `getCreateComposeEnvFileCommand`'s interpolated `.env` beside it, and
     * `composeStartCommand` rewriting that same file on a Start — so
     * `composePath` is the same write primitive as an application's
     * `publishDirectory` and not a milder read-only one. It said "four callers
     * and two of them" until the invocations were counted; `compose.dto.ts`,
     * which is where the refusal actually lives, has carried six and three
     * since. A nested path is a supported configuration and has to keep
     * working; what may not happen is any of those writes landing outside the
     * stack's own code directory.
     *
     * Asserted over *every* `base64 -d` or `printf` redirect the deploy
     * produced (the `.env` is written from the program's environment)
     * rather than the two this path builds today — the Start's write is a
     * different route to the same file — so a further write added later is
     * covered by this test rather than exempt from it.
     */
    it('writes the compose file and its .env inside the stack code directory for a nested composePath', async () => {
      const { ownerSession, created } = await setUpRawCompose();

      const patched = await request(server)
        .patch(`/compose/${created.composeId}`)
        .set('Cookie', ownerSession.cookie)
        .send({
          sourceType: 'git',
          customGitUrl: 'https://git.example.com/acme/stack.git',
          customGitBranch: 'main',
          composePath: './deploy/docker-compose.yml',
        });
      expect(patched.status).toBe(200);

      // A git stack's content only exists once the clone has run, and the clone
      // is mocked — so the file the deploy reads back has to come from the same
      // boundary the real one would.
      execMock.execAsync.mockImplementation((command: string) =>
        command.startsWith('cat ')
          ? Promise.resolve({ ...ok, stdout: WORDPRESS_COMPOSE })
          : teardownSucceeds(command),
      );

      const deployable = await compose.findDeployable(created.composeId);
      await engine.deployCompose(deployable, {
        title: 'Manual deployment',
        description: '',
      });

      const codeDirectory = `${platformRoot()}/compose/wp-stack/code`;
      const written = executedCommands().flatMap((command) =>
        [
          ...command.matchAll(/(?:base64 -d|printf '%s' "\$\w+") > (\S+?);/g),
        ].map((match) => match[1]),
      );
      expect(written).toContain(`${codeDirectory}/deploy/docker-compose.yml`);
      expect(written).toContain(`${codeDirectory}/deploy/.env`);
      for (const target of written) {
        expect(target.startsWith(`${codeDirectory}/`)).toBe(true);
      }
    });

    // The `.env` is every generated secret and a stack's variables are
    // the operator's own values, and a deploy program's text is what any
    // local user on the machine reads out of `ps` while the deploy runs.
    it.each(['docker-compose', 'stack'] as const)(
      'never puts a variable’s value in a %s deploy program’s text, which ps can read',
      async (composeType) => {
        const { ownerCtx, project, created } = await setUpRawCompose();
        const secret = 'sk-live-9f3ad2c1';
        await compose.update(ownerCtx, created.composeId, {
          composeType,
          env: `API_TOKEN=${secret}\nDB_PASSWORD=\${{project.SHARED}}`,
        });
        await projects.update(ownerCtx, project.projectId, {
          env: 'SHARED=p@ss-from-project',
        });

        const deployable = await compose.findDeployable(created.composeId);
        await engine.deployCompose(deployable, {
          title: 'Manual deployment',
          description: '',
        });

        const calls = execMock.execAsync.mock.calls as [
          string,
          { env?: Record<string, string> } | undefined,
        ][];
        for (const [text] of calls) {
          for (const value of [secret, 'p@ss-from-project']) {
            expect(text).not.toContain(value);
            // Nor inside a base64 payload the program decodes.
            for (const [payload] of text.matchAll(/[A-Za-z0-9+/=]{16,}/g)) {
              expect(
                Buffer.from(payload, 'base64').toString('utf-8'),
              ).not.toContain(value);
            }
          }
        }
        // …and the build still has them, in its environment.
        const build = calls.find(([text]) =>
          text.includes(`printf '%s' "$CG_COMPOSE_ENV"`),
        );
        expect(build?.[1]?.env?.CG_COMPOSE_ENV).toContain(
          `API_TOKEN=${secret}\nDB_PASSWORD=p@ss-from-project\n`,
        );
        if (composeType === 'stack') {
          expect(build?.[1]?.env?.CG_COMPOSE_STACK_ENV).toContain(
            `export API_TOKEN=${secret}`,
          );
        }
      },
    );

    it('fails a platform-host deploy whose .env is over the kernel’s cap on one environment string, and says so in the log', async () => {
      const { ownerCtx, created } = await setUpRawCompose();
      await compose.update(ownerCtx, created.composeId, {
        env: `BLOB=${'x'.repeat(140 * 1024)}`,
      });

      const deployable = await compose.findDeployable(created.composeId);
      await expect(
        engine.deployCompose(deployable, {
          title: 'Manual deployment',
          description: '',
        }),
      ).rejects.toThrow(/The Compose's \.env is 141 KiB; the limit is 128 KiB/);

      // The refusal reached the Deployment's log (base64, as every non-exec
      // error does), and no build ran.
      const logged = decodedWrites(executedCommands());
      expect(
        logged.some((line) =>
          line.includes("The Compose's .env is 141 KiB; the limit is 128 KiB"),
        ),
      ).toBe(true);
      expect(executedCommands().some((c) => c.includes('up -d --build'))).toBe(
        false,
      );
    });

    it('marks the compose stack and deployment record as error when the build fails', async () => {
      const { ownerCtx, ownerSession, created } = await setUpRawCompose();

      execMock.execAsync.mockImplementation((command: string) => {
        if (command.includes('up -d --build')) {
          return Promise.reject(new Error('docker daemon exploded'));
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      });

      const deployable = await compose.findDeployable(created.composeId);
      await expect(
        engine.deployCompose(deployable, {
          title: 'Manual deployment',
          description: '',
        }),
      ).rejects.toThrow('docker daemon exploded');

      const found = await compose.findOne(ownerCtx, created.composeId);
      expect(found.composeStatus).toBe('error');

      const history = await request(server)
        .get(`/compose/${created.composeId}/deployments`)
        .set('Cookie', ownerSession.cookie);
      expect((history.body as { status: string }[])[0]).toMatchObject({
        status: 'error',
      });
    });
  });

  /**
   * `composeFile` is an `encryptedText` column, and none of the things
   * that read it may notice.
   *
   * The column holds a docker-compose file an operator authors, which
   * Cloudgate takes verbatim and materializes on a build server — ADR 0015's
   * rule without modification, and the column that rule recorded as *open and
   * qualifying* rather than answered. It is the stronger candidate than either
   * deploy-webhook column: it routinely carries literal `environment:` values
   * even though the `encryptedText` `compose.env` sits beside it for exactly
   * those, and one file's blast radius is every service in a stack.
   *
   * Nothing queries the column by value — the one thing AES-GCM under a random
   * IV would break, and the reason better-auth's `session.token` is exempt from
   * the secret-bearing-columns sweep — so the whole risk of the change is in
   * the readers, and the two that can hide a silently broken feature are here:
   * the author's own round trip, and the bytes the build server receives. Both
   * are needed. A column that encrypts correctly and ships `enc:v1:…` to
   * `base64 -d` deploys a stack definition of one line of ciphertext, and every
   * other assertion in this file matches on a path or a verb rather than on the
   * payload.
   */
  describe('the compose file at rest', () => {
    /**
     * A compose file whose bytes are the point. Two credentials of the shape
     * ADR 0015 names — the one this column is *for*, since `compose.env` exists
     * beside it and operators write `environment:` anyway — and then every byte
     * a base64 round trip, a shell quote or a JSON body could plausibly eat:
     * both quote characters, a backslash, a literal `$$`, a tab and a trailing
     * newline.
     *
     * Written out here rather than derived from `WORDPRESS_COMPOSE`, so the
     * expectation cannot be recomputed the way the column computes it (§1.7).
     */
    const CREDENTIAL_COMPOSE = [
      'services:',
      '  db:',
      '    image: mariadb:11',
      '    environment:',
      "      - MARIADB_ROOT_PASSWORD=p@ss w'rd\\$$",
      '      - API_TOKEN=sk-live-9f3ad2',
      '      - AWKWARD="a\tb"',
      '  web:',
      '    image: wordpress:6',
      '',
    ].join('\n');

    /** The `compose_file` column exactly as Postgres holds it, driver-side. */
    const composeFileAtRest = async (composeId: string) =>
      (
        await ctx.db.$client.query<{ compose_file: string }>(
          'select compose_file from compose where compose_id = $1',
          [composeId],
        )
      ).rows[0].compose_file;

    it('returns a compose file to its author byte-identical over ciphertext at rest', async () => {
      const { ownerSession, environment } = await setUpEnvironment();

      const created = await request(server)
        .post('/compose')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'Wordpress',
          appName: 'secret-stack',
          environmentId: environment.environmentId,
          composeFile: CREDENTIAL_COMPOSE,
        });
      expect(created.status).toBe(201);
      const { composeId } = created.body as { composeId: string };

      // The create response and the single read are two different queries over
      // the column, and both are the operator who wrote it — an author reading
      // their own file back is the one echo this classification does not
      // forbid (ADR 0015).
      expect((created.body as { composeFile: string }).composeFile).toBe(
        CREDENTIAL_COMPOSE,
      );

      const found = await request(server)
        .get(`/compose/${composeId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(200);
      expect((found.body as { composeFile: string }).composeFile).toBe(
        CREDENTIAL_COMPOSE,
      );

      // And what a `pg_dump`, a read replica or a backup tarball hands its
      // reader, which is the only thing ADR 0006 claims to defend.
      const stored = await composeFileAtRest(composeId);
      expect(stored.startsWith('enc:v1:')).toBe(true);
      expect(stored).not.toContain('sk-live-9f3ad2');
      expect(stored).not.toContain('MARIADB_ROOT_PASSWORD');
    });

    it('deploys the decrypted file to the build server', async () => {
      const { ownerCtx, environment } = await setUpEnvironment();
      const created = await compose.create(ownerCtx, {
        name: 'Wordpress',
        appName: 'secret-stack',
        environmentId: environment.environmentId,
        composeFile: CREDENTIAL_COMPOSE,
      });
      await compose.update(ownerCtx, created.composeId, { sourceType: 'raw' });

      const deployable = await compose.findDeployable(created.composeId);
      await engine.deployCompose(deployable, {
        title: 'Manual deployment',
        description: '',
      });

      // The build server has to receive plaintext — it is what `docker compose`
      // reads. Two writes carry the file on a raw deploy (the clone's
      // materialization and the domain-injected build write), and the
      // credentials have to survive both: `writeDomainsToCompose` re-serializes
      // the document, so this is also the assertion that the values are still
      // the operator's after a parse and a stringify.
      const writes = decodedWrites(executedCommands());
      expect(writes.length).toBeGreaterThan(0);
      for (const write of writes.filter((w) => w.includes('mariadb:11'))) {
        expect(write).toContain("MARIADB_ROOT_PASSWORD=p@ss w'rd\\$$");
        expect(write).toContain('API_TOKEN=sk-live-9f3ad2');
        expect(write).not.toContain('enc:v1:');
      }
      expect(writes.some((w) => w.includes('API_TOKEN=sk-live-9f3ad2'))).toBe(
        true,
      );
    });

    it('reads and re-encrypts a compose file written before the column had a type', async () => {
      const { ownerCtx, environment } = await setUpEnvironment();
      const created = await compose.create(ownerCtx, {
        name: 'Wordpress',
        appName: 'legacy-stack',
        environmentId: environment.environmentId,
        composeFile: WORDPRESS_COMPOSE,
      });

      // A row as an install that predates this change holds it: plaintext, no
      // `enc:v1:` prefix. Written with the driver because the point is to get
      // past the `toDriver` that would otherwise encrypt it.
      await ctx.db.$client.query(
        'update compose set compose_file = $1 where compose_id = $2',
        [CREDENTIAL_COMPOSE, created.composeId],
      );
      expect(await composeFileAtRest(created.composeId)).toBe(
        CREDENTIAL_COMPOSE,
      );

      // ADR 0006: a value without the prefix is passed through on read, so the
      // row keeps deploying rather than throwing or answering ciphertext. This
      // is what makes the change need no migration and no backfill.
      const found = await compose.findOne(ownerCtx, created.composeId);
      expect(found.composeFile).toBe(CREDENTIAL_COMPOSE);

      // A PATCH that omits `composeFile` writes every other column and leaves
      // the plaintext where it was — `update` merges
      // `data.composeFile ?? row.composeFile`, so the residue closes on the
      // next write of *this* column and not before.
      await compose.update(ownerCtx, created.composeId, { name: 'Renamed' });
      expect(await composeFileAtRest(created.composeId)).toBe(
        CREDENTIAL_COMPOSE,
      );

      const edited = `${CREDENTIAL_COMPOSE}  cache:\n    image: redis:7\n`;
      await compose.update(ownerCtx, created.composeId, {
        composeFile: edited,
      });
      expect(
        (await composeFileAtRest(created.composeId)).startsWith('enc:v1:'),
      ).toBe(true);
      expect(
        (await compose.findOne(ownerCtx, created.composeId)).composeFile,
      ).toBe(edited);
    });
  });

  describe('start / stop', () => {
    it('stop runs docker compose stop under env -i and marks the stack stopped, which a never-deployed one cannot be', async () => {
      const { ownerCtx, ownerSession, created } = await setUpRawCompose();
      // The control is the created row's status, not a literal: the property
      // is that the two differ, and `'idle'` spelled twice would still pass if
      // the column's default moved onto the stop status (as it once did).
      expect(created.composeStatus).toBe('idle');

      const res = await request(server)
        .post(`/compose/${created.composeId}/stop`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(200);

      expect(
        executedCommands().some((c) =>
          c.includes('env -i PATH="$PATH" docker compose -p wp-stack stop'),
        ),
      ).toBe(true);

      const found = await compose.findOne(ownerCtx, created.composeId);
      expect(found.composeStatus).toBe('stopped');
      expect(found.composeStatus).not.toBe(created.composeStatus);
    });

    it('stop removes the stack for the stack compose type, and marks it stopped', async () => {
      const { ownerCtx, ownerSession, created } = await setUpRawCompose();
      await compose.update(ownerCtx, created.composeId, {
        composeType: 'stack',
      });

      await request(server)
        .post(`/compose/${created.composeId}/stop`)
        .set('Cookie', ownerSession.cookie);

      expect(
        executedCommands().some((c) => c.includes('docker stack rm wp-stack')),
      ).toBe(true);
      expect(
        (await compose.findOne(ownerCtx, created.composeId)).composeStatus,
      ).toBe('stopped');
    });

    it('start brings the project up from its code directory', async () => {
      const { ownerCtx, ownerSession, created } = await setUpRawCompose();

      const res = await request(server)
        .post(`/compose/${created.composeId}/start`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(200);

      const start = executedCommands().find((c) =>
        c.includes('docker compose -p wp-stack -f docker-compose.yml up -d'),
      );
      expect(start).toBeDefined();

      const found = await compose.findOne(ownerCtx, created.composeId);
      expect(found.composeStatus).toBe('done');
    });

    /**
     * H-98 at the route. `start` runs `docker compose up -d` over the *stored*
     * converted file, which for every stack deployed before those defaults
     * carries neither `restart:` nor `logging:` — four such stacks on the VPS —
     * so Start brought them back with `RestartPolicy=no` and an uncapped log
     * driver and the next daemon restart dropped them again. The unit spec pins
     * the command builder; this pins that the route reaches it, with the bytes
     * it read off the server.
     */
    it('start re-applies the platform defaults to the converted file on disk (H-98)', async () => {
      const { ownerSession, created } = await setUpRawCompose();
      const preWave = `services:
  wordpress:
    image: wordpress:6
`;
      execMock.execAsync.mockImplementation((command: string) =>
        Promise.resolve(
          command.startsWith('cat ') ? { ...ok, stdout: preWave } : ok,
        ),
      );

      const res = await request(server)
        .post(`/compose/${created.composeId}/start`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(200);

      const written = decodedWrites(executedCommands());
      expect(written).toHaveLength(1);
      expect(written[0]).toContain('restart: unless-stopped');
      expect(written[0]).toContain('max-size: 10m');
      expect(written[0]).toContain('max-file: "3"');

      // One command, not two: the `up` is conditional on the write landing, and
      // it is the same `up` this route always ran — no build, no clone, no
      // domain re-injection. Start is still a lifecycle rung (ADR-0011).
      const start = executedCommands().find((c) => c.includes('up -d'));
      expect(start).toContain(
        `| base64 -d > ${platformRoot()}/compose/wp-stack/code/docker-compose.yml &&`,
      );
      expect(start).toContain(
        'docker compose -p wp-stack -f docker-compose.yml up -d',
      );
      expect(start).not.toContain('--build');
    });

    it('start writes nothing when the file on disk already carries both defaults (H-98)', async () => {
      const { ownerSession, created } = await setUpRawCompose();
      // What every stack deployed since the log cap has on disk. A Start must not
      // rewrite it — the common case touches nothing.
      const deployed = `services:
  wordpress:
    image: wordpress:6
    restart: unless-stopped
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "3"
`;
      execMock.execAsync.mockImplementation((command: string) =>
        Promise.resolve(
          command.startsWith('cat ') ? { ...ok, stdout: deployed } : ok,
        ),
      );

      const res = await request(server)
        .post(`/compose/${created.composeId}/start`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(200);

      expect(decodedWrites(executedCommands())).toEqual([]);
    });

    /**
     * H-106. This route used to answer 200 for a `stack` row, having exec'd
     * nothing: the whole method was the permission check, the two reads and
     * `updateStatus('done')`. Running nothing is right — a swarm stack is
     * (re)started by `docker stack deploy` — but `stop` on a `stack` row is
     * `docker stack rm`, so Stop → Start left the row saying `done` with zero
     * tasks on the host. The refusal follows `remove-containers`', which turns
     * away the same type one rung along.
     */
    it('refuses a swarm stack, which is (re)started by deploying it', async () => {
      const { ownerCtx, ownerSession, created } = await setUpRawCompose();
      await compose.update(ownerCtx, created.composeId, {
        composeType: 'stack',
      });
      await compose.stop(ownerCtx, created.composeId);
      // Forget the setup's and the Stop's shell, so `executedCommands()` speaks
      // for the Start alone.
      execMock.execAsync.mockClear();
      execMock.execAsyncRemote.mockClear();

      const res = await request(server)
        .post(`/compose/${created.composeId}/start`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(400);
      const { message } = res.body as { message: string };
      expect(message).toContain(
        'only to a compose stack of the docker-compose type',
      );
      // The message names the control that does work, or the refusal costs the
      // operator the same guess the false `done` did.
      expect(message).toContain('Deploy');

      // Nothing ran on the way to being refused — not even the `cat` the
      // docker-compose branch opens with.
      expect(executedCommands()).toEqual([]);
      // And the status is the `stopped` Stop left, not the `done` this route
      // used to write over it: a refused action reports no state of its own.
      expect(
        (await compose.findOne(ownerCtx, created.composeId)).composeStatus,
      ).toBe('stopped');
    });

    /**
     * U-116. Start, Stop and Remove containers on a stack that was never
     * deployed `cd` into a directory no Deployment has created yet, and the
     * shell's `can't cd` was an unhandled 500 — which the console reads as
     * "Docker was still working when the connection closed", about a command
     * Docker never saw. The directory is asked about only once the command has
     * failed, so the success path is the command it always was.
     */
    describe('on a stack that was never deployed', () => {
      const directoryProbe = (command: string) =>
        command.startsWith('if [ -d ');
      const neverDeployed = (command: string) => {
        if (directoryProbe(command)) {
          return Promise.resolve({ ...ok, stdout: 'absent\n' });
        }
        if (command.includes('cd ') && command.includes('docker compose')) {
          return Promise.reject(
            new ExecError('Command failed with exit code 2', {
              command,
              stdout: '',
              stderr: `/bin/sh: 1: cd: can't cd to ${platformRoot()}/compose/wp-stack/code`,
              exitCode: 2,
            }),
          );
        }
        return Promise.resolve(ok);
      };

      it.each([
        ['start', 'start'],
        ['stop', 'stop'],
        ['remove-containers', 'remove the containers of'],
      ])(
        '%s answers 409 saying the stack was never deployed, and writes no status',
        async (route, verb) => {
          const { ownerCtx, ownerSession, created } = await setUpRawCompose();
          execMock.execAsync.mockImplementation(neverDeployed);

          const res = await request(server)
            .post(`/compose/${created.composeId}/${route}`)
            .set('Cookie', ownerSession.cookie);

          expect(res.status).toBe(409);
          const { message } = res.body as { message: string };
          expect(message).toContain(`'wp-stack' on its Server to ${verb}`);
          expect(message).toContain('no Deployment of this stack has run');
          // A Server path is an internal detail (§2.5): the probe asks about
          // it, the message names the cause.
          expect(message).not.toContain(platformRoot());
          expect(message).not.toMatch(/\.$/);
          // The probe asked about the directory the failed command `cd`'d into.
          const probe = executedCommands().find(directoryProbe);
          expect(probe).toContain(`${platformRoot()}/compose/wp-stack`);
          // A refusal reports no state of its own: not the `error` Stop and
          // Remove containers paint over a failure, nor Start's either.
          expect(
            (await compose.findOne(ownerCtx, created.composeId)).composeStatus,
          ).toBe(created.composeStatus);
        },
      );

      /**
       * Start is here as well as Stop. Its failure used to write
       * `idle` — the never-deployed word — over a stack whose directory proves
       * a Deployment ran, and after a `compose up -d` that may have brought
       * some of its services up. That is a state nobody knows, which is what
       * `error` means on this column, and what Stop's failure writes.
       */
      it.each(['stop', 'start'])(
        '%s still fails as it did when the directory is there, and marks the stack error',
        async (route) => {
          const { ownerCtx, ownerSession, created } = await setUpRawCompose();
          execMock.execAsync.mockImplementation((command: string) =>
            directoryProbe(command)
              ? Promise.resolve({ ...ok, stdout: 'present\n' })
              : neverDeployed(command),
          );

          const res = await request(server)
            .post(`/compose/${created.composeId}/${route}`)
            .set('Cookie', ownerSession.cookie);

          expect(res.status).toBe(500);
          expect(
            (await compose.findOne(ownerCtx, created.composeId)).composeStatus,
          ).toBe('error');
        },
      );
    });

    it('requires deployment:create — a plain member cannot stop the stack', async () => {
      const { ownerSession, created } = await setUpRawCompose();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );

      const res = await request(server)
        .post(`/compose/${created.composeId}/stop`)
        .set('Cookie', invitee.cookie);
      expect(res.status).toBe(403);
    });
  });

  /**
   * Remove containers, the rung between Stop and Delete. Stop leaves a
   * `docker-compose` project's containers exited and still holding their
   * volumes, which is why a volume restore could not be completed from the
   * console for that one service type.
   */
  describe('remove containers', () => {
    /**
     * Puts the invitee on a licensed custom role. The enterprise path is the
     * only one where a role's statements come off `organization_role` rows, so
     * it is the only way to hold `volumeBackup:['restore']` *without*
     * `service:['delete']` — the static member role hands out both, which is
     * why the case this gate was chosen for cannot be expressed with it.
     */
    async function putOnCustomRole(
      organizationId: string,
      userId: string,
      role: string,
      permission: Record<string, string[]>,
      accessedServices: string[] = [],
    ) {
      await ctx.db.insert(licenseKey).values({
        organizationId,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });
      await ctx.db
        .insert(organizationRole)
        .values({ organizationId, role, permission });
      await ctx.db
        .update(member)
        .set({ role, accessedServices })
        .where(
          and(
            eq(member.userId, userId),
            eq(member.organizationId, organizationId),
          ),
        );
    }

    /** Forgets the setup's shell so `executedCommands()` speaks for the action. */
    const clearExec = () => {
      execMock.execAsync.mockClear();
      execMock.execAsyncRemote.mockClear();
    };

    it('runs docker compose rm --stop --force and marks the stack stopped', async () => {
      const { ownerCtx, ownerSession, created } = await setUpRawCompose();
      clearExec();

      const res = await request(server)
        .post(`/compose/${created.composeId}/remove-containers`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(200);
      // Answers the updated row, exactly as stop does.
      // `stopped`, as Stop: the stack was deployed and has been taken down on
      // purpose, and Start brings it back — which is not what the
      // never-deployed `idle` it was created with says.
      expect(res.body).toMatchObject({
        composeId: created.composeId,
        composeStatus: 'stopped',
      });

      const commands = executedCommands();
      expect(
        commands.some((c) =>
          c.includes(
            'env -i PATH="$PATH" docker compose -p wp-stack rm --stop --force',
          ),
        ),
      ).toBe(true);

      // Nothing else was torn down on the way: no `-v` taking the volume the
      // restore is waiting on, no `down` taking the network Traefik is attached
      // to, and no `rm -rf` taking the project directory start reads.
      const all = commands.join('\n');
      expect(all).not.toContain('--volumes');
      expect(all).not.toMatch(/(^|\s)-v(\s|$)/);
      expect(all).not.toContain('docker compose -p wp-stack down');
      expect(all).not.toContain('network disconnect');
      expect(all).not.toContain('rm -rf');
      // And no lock was taken: this stack has no turn-off volume-backup row, so
      // there is no volume this removal can contend for.
      expect(all).not.toContain('LOCK_PATH');

      const found = await compose.findOne(ownerCtx, created.composeId);
      expect(found.composeStatus).toBe('stopped');
    });

    it('refuses a swarm stack, whose Stop already leaves no container behind', async () => {
      const { ownerCtx, ownerSession, created } = await setUpRawCompose();
      await compose.update(ownerCtx, created.composeId, {
        composeType: 'stack',
      });
      clearExec();

      const res = await request(server)
        .post(`/compose/${created.composeId}/remove-containers`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain(
        'only to a compose stack of the docker-compose type',
      );
      // Nothing was removed on the way to being refused.
      expect(executedCommands()).toEqual([]);
      expect(
        (await compose.findOne(ownerCtx, created.composeId)).composeStatus,
      ).not.toBe('error');
    });

    it('refuses a caller whose role lacks the lifecycle statement', async () => {
      const { organizationId, ownerSession, created } = await setUpRawCompose();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      // Row-level access granted, so the statement is the only thing missing.
      await putOnCustomRole(
        organizationId,
        invitee.id,
        'reader',
        { service: ['read'] },
        [created.composeId],
      );
      clearExec();

      const res = await request(server)
        .post(`/compose/${created.composeId}/remove-containers`)
        .set('Cookie', invitee.cookie);

      expect(res.status).toBe(403);
      expect(executedCommands()).toEqual([]);
    });

    it('refuses a caller with the statement but no row-level access to the service', async () => {
      const { ownerSession, created } = await setUpRawCompose();
      // The static member role already carries deployment:['create'], so this
      // caller clears the statement and is refused on the grant alone.
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      clearExec();

      const res = await request(server)
        .post(`/compose/${created.composeId}/remove-containers`)
        .set('Cookie', invitee.cookie);

      expect(res.status).toBe(403);
      expect(executedCommands()).toEqual([]);
    });

    it('allows a custom role holding volumeBackup restore and the lifecycle statement but not service delete', async () => {
      const { organizationId, ownerSession, created } = await setUpRawCompose();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'restorer@example.com',
        'member',
      );
      await putOnCustomRole(
        organizationId,
        invitee.id,
        'volume-restorer',
        {
          service: ['read'],
          deployment: ['create'],
          volumeBackup: ['read', 'restore'],
        },
        [created.composeId],
      );
      clearExec();

      const res = await request(server)
        .post(`/compose/${created.composeId}/remove-containers`)
        .set('Cookie', invitee.cookie);
      expect(res.status).toBe(200);
      expect(
        executedCommands().some((c) => c.includes('rm --stop --force')),
      ).toBe(true);

      // And the point of the gate: this same caller cannot delete the stack, so
      // gating Remove containers on service:['delete'] would have left them with
      // a restore they still could not complete.
      const deleted = await request(server)
        .delete(`/compose/${created.composeId}`)
        .set('Cookie', invitee.cookie);
      expect(deleted.status).toBe(403);
    });

    /**
     * The volume lock. Remove containers is the third operation that
     * mutates a Docker volume — it takes the container out from under a
     * turn-off backup that stopped it and is still tarring — so it holds the
     * lock of every volume a turn-off volume-backup row of this stack names,
     * and answers a lock it cannot get with a 409 rather than queueing behind
     * however long a tar takes.
     */
    describe('volume lock', () => {
      /** An org-scoped destination for this stack's backup rows to hang off. */
      async function seedDestination(organizationId: string) {
        const [row] = await ctx.db
          .insert(destination)
          .values({
            name: 'backups',
            accessKey: 'key',
            secretAccessKey: 'secret',
            bucket: 'bucket',
            region: 'eu-west-1',
            endpoint: 'https://s3.example.com',
            organizationId,
          })
          .returning();
        return row;
      }

      /** A volume-backup row of one compose stack, turn-off by default. */
      async function seedVolumeBackup(
        destinationId: string,
        composeId: string,
        volumeName: string,
        overrides: { turnOff?: boolean; enabled?: boolean } = {},
      ) {
        await ctx.db.insert(volumeBackup).values({
          name: `backup of ${volumeName}`,
          volumeName,
          prefix: `${volumeName}/`,
          serviceType: 'compose',
          serviceName: 'wordpress',
          schedule: '0 2 * * *',
          turnOff: true,
          composeId,
          destinationId,
          ...overrides,
        });
      }

      /**
       * What a busy fail-fast acquisition looks like at the exec seam: exit 75
       * with the marker line on stdout. A real `flock` cannot be held from a
       * test whose exec is a mock, so the refusal is injected where the service
       * reads it from rather than produced by a second process.
       */
      const busy = (volumeName?: string) =>
        new ExecError('Command failed with exit code 75', {
          command: 'docker compose rm --stop --force',
          stdout: volumeName
            ? `Waiting for volume lock: ${volumeName}\nVolume lock busy: ${volumeName}\n`
            : '',
          stderr: '',
          exitCode: 75,
        });

      /** The one command the action dispatched. */
      const dispatched = () => {
        const commands = executedCommands();
        expect(commands).toHaveLength(1);
        return commands[0];
      };

      it('locks each turn-off volume of this stack once, and nothing else', async () => {
        const { organizationId, ownerCtx, ownerSession, created, environment } =
          await setUpRawCompose();
        const store = await seedDestination(organizationId);
        // Two rows naming the same volume: one lock, not two.
        await seedVolumeBackup(store.destinationId, created.composeId, 'wp-db');
        await seedVolumeBackup(store.destinationId, created.composeId, 'wp-db');
        // Not turn-off, so it never stops a container and cannot contend.
        await seedVolumeBackup(
          store.destinationId,
          created.composeId,
          'wp-cache',
          { turnOff: false },
        );
        // Disabled, but still lockable: its schedule does not fire, and its run
        // can still be triggered by hand.
        await seedVolumeBackup(
          store.destinationId,
          created.composeId,
          'wp-uploads',
          { enabled: false },
        );
        // Another stack's turn-off volume, which this action must not touch.
        const other = await compose.create(ownerCtx, {
          name: 'Shop',
          appName: 'shop-stack',
          environmentId: environment.environmentId,
          composeFile: WORDPRESS_COMPOSE,
        });
        await seedVolumeBackup(
          store.destinationId,
          other.composeId,
          'shop-data',
        );
        clearExec();

        const res = await request(server)
          .post(`/compose/${created.composeId}/remove-containers`)
          .set('Cookie', ownerSession.cookie);
        expect(res.status).toBe(200);

        const command = dispatched();
        // Sorted, so two callers naming the same volumes cannot deadlock.
        //
        // The delimiter is `'…'`, not `"…"`: H-32 made every `echo` in the lock
        // a `quote()`d word, because an `echo` that names a value is a sink like
        // any other and `"…"` never stopped a `$(…)`. What is asserted — which
        // volumes this action waits on, and in what order — is unchanged; only
        // the quote character the volume name is read out from between moved.
        expect(
          [...command.matchAll(/echo 'Waiting for volume lock: ([^']+)'/g)].map(
            (match) => match[1],
          ),
        ).toEqual(['wp-db', 'wp-uploads']);
        expect(command).toContain(
          `LOCK_PATH=${platformRoot()}/volume-backup-lock-wp-db`,
        );
        // The volumes that cannot contend were not locked: a non-turn-off row's
        // volume, and another stack's. Both needles are plain `[a-z-]` words
        // that `quote()` leaves alone, so these negatives still match the
        // regression they were written for.
        expect(command).not.toContain('wp-cache');
        expect(command).not.toContain('shop-data');
      });

      it('answers a held lock with 409 naming the volume, and removes no containers', async () => {
        const { organizationId, ownerCtx, ownerSession, created } =
          await setUpRawCompose();
        const store = await seedDestination(organizationId);
        await seedVolumeBackup(store.destinationId, created.composeId, 'wp-db');
        clearExec();
        execMock.execAsync.mockRejectedValue(busy('wp-db'));

        const res = await request(server)
          .post(`/compose/${created.composeId}/remove-containers`)
          .set('Cookie', ownerSession.cookie);
        expect(res.status).toBe(409);
        expect((res.body as { message: string }).message).toContain(
          "Volume 'wp-db' is busy",
        );

        // No container was removed: the `rm` sits inside the acquisition that
        // exited 75, so the script stopped before reaching it.
        const command = dispatched();
        expect(command.indexOf('exit 75')).toBeLessThan(
          command.indexOf('rm --stop --force'),
        );
        // And the status was left alone — nothing was attempted, so painting the
        // stack red would report damage the operator would then go looking for.
        const found = await compose.findOne(ownerCtx, created.composeId);
        expect(found.composeStatus).toBe('idle');
      });

      it('names the volumes it was holding when the marker did not reach it', async () => {
        const { organizationId, ownerSession, created } =
          await setUpRawCompose();
        const store = await seedDestination(organizationId);
        await seedVolumeBackup(store.destinationId, created.composeId, 'wp-db');
        await seedVolumeBackup(
          store.destinationId,
          created.composeId,
          'wp-uploads',
        );
        clearExec();
        execMock.execAsync.mockRejectedValue(busy());

        const res = await request(server)
          .post(`/compose/${created.composeId}/remove-containers`)
          .set('Cookie', ownerSession.cookie);
        expect(res.status).toBe(409);
        expect((res.body as { message: string }).message).toContain(
          "Volume 'wp-db' or 'wp-uploads' is busy",
        );
      });

      it('does not answer 409 for a stack that took no lock at all', async () => {
        // No turn-off rows, so no preamble: an exit 75 can only have come out of
        // the `rm` itself, and a 409 naming no volume would be a lie.
        const { ownerCtx, ownerSession, created } = await setUpRawCompose();
        clearExec();
        execMock.execAsync.mockRejectedValue(busy());

        const res = await request(server)
          .post(`/compose/${created.composeId}/remove-containers`)
          .set('Cookie', ownerSession.cookie);
        expect(res.status).toBe(500);
        expect(
          (await compose.findOne(ownerCtx, created.composeId)).composeStatus,
        ).toBe('error');
      });

      it('still paints the stack error when the removal fails for any other reason', async () => {
        const { organizationId, ownerCtx, ownerSession, created } =
          await setUpRawCompose();
        const store = await seedDestination(organizationId);
        await seedVolumeBackup(store.destinationId, created.composeId, 'wp-db');
        clearExec();
        execMock.execAsync.mockRejectedValue(
          new ExecError('Command failed with exit code 1', {
            command: 'docker compose rm --stop --force',
            stdout: '',
            stderr: 'no such service',
            exitCode: 1,
          }),
        );

        const res = await request(server)
          .post(`/compose/${created.composeId}/remove-containers`)
          .set('Cookie', ownerSession.cookie);
        // Not a 409: only exit 75 means "the lock is held, try again".
        expect(res.status).toBe(500);
        expect(
          (await compose.findOne(ownerCtx, created.composeId)).composeStatus,
        ).toBe('error');
      });
    });
  });

  describe('loadServices', () => {
    it('lists the service names of a raw compose stack', async () => {
      const { ownerSession, created } = await setUpRawCompose();

      const res = await request(server)
        .get(`/compose/${created.composeId}/services`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(['wordpress', 'db']);
    });

    /**
     * A non-raw stack's file is `cat`'d on the build server, and the path
     * is `composeDirectoryOn(compose.serverId)/<appName>/code/<composePath>` —
     * the local `composeDirectory()` this used to name was deleted with its
     * last caller — `composePath` being
     * a column a caller writes through `PATCH /compose/:id`. Read from inside
     * the exec mock rather than from `getComposeFilePath`, so a fix that quoted
     * the helper's callers but not this one is distinguishable.
     */
    it('quotes the compose path it cats off the build server', async () => {
      const { ownerSession, created } = await setUpRawCompose();
      const patched = await request(server)
        .patch(`/compose/${created.composeId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ sourceType: 'git', composePath: `./${SHELL_PAYLOAD}.yml` });
      expect(patched.status).toBe(200);

      execMock.execAsync.mockClear();
      const res = await request(server)
        .get(`/compose/${created.composeId}/services`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(200);

      const command = executedCommands().find((c) => c.startsWith('cat '));
      expect(command).toBeDefined();
      expectQuotedInCommand(command as string);
    });

    /**
     * The `composePath` traversal on the same column, and the other kind of
     * answer for it. Quoting settles what may be interpolated; it says nothing
     * about where the path may *point*, and `getComposeFilePath` `join`s
     * `composePath` onto the stack's code directory with a `join` that
     * normalises — so `../../..` moved every one of its six callers off the
     * stack's tree, three of them writes (it used to say four and two).
     * `compose-commands.spec.ts` holds the rule and proves the escape against
     * the helper; this pins that the global pipe applies it and that a refused
     * PATCH leaves the column alone.
     */
    it('refuses a composePath that walks out of the stack code directory', async () => {
      const { ownerCtx, ownerSession, created } = await setUpRawCompose();

      const refused = await request(server)
        .patch(`/compose/${created.composeId}`)
        .set('Cookie', ownerSession.cookie)
        .send({
          sourceType: 'git',
          composePath: '../../../traefik/dynamic/traefik.yml',
        });
      expect(refused.status).toBe(400);

      // The whole body is refused, so the stack is still the raw one it was —
      // and the column still holds the schema default the row was created with.
      const found = await compose.findOne(ownerCtx, created.composeId);
      expect(found.composePath).toBe('./docker-compose.yml');
      expect(found.sourceType).toBe('raw');
    });
  });

  /**
   * Delete's ordering. This block used to hold a test called 'still
   * deletes the row when the runtime teardown fails', asserting a 200 and an
   * empty table — the behaviour the old comment promised, "a dead daemon must
   * not resurrect the database row". That is the bug, not a feature to keep:
   * the row is the only handle the product has on the stack, and per ADR-0008 a
   * container that resolves to no Service is *unmanaged* and reached through
   * machine-level `docker:read`, so dropping the row while the containers still
   * run hands them to every organization on the host. `CONTEXT.md`'s **Delete**
   * is "the record, its containers, its network and its project directory" —
   * one act, not a record removal with a best-effort wish attached, and this is
   * Delete's rung specifically: **Stop** and **Remove containers** both leave
   * the record standing and are unaffected.
   *
   * So the assertion below is the exact inverse of the deleted one — on a
   * teardown failure the row *survives* — and it is here to stop the flip being
   * reverted as a regression by anyone reading the old promise.
   */
  describe('remove teardown', () => {
    const composeRows = async (
      composeId: string,
    ): Promise<{ compose_id: string }[]> => {
      const raw = await ctx.db.$client.query<{ compose_id: string }>(
        'select compose_id from compose where compose_id = $1',
        [composeId],
      );
      return raw.rows;
    };

    it('tears the project down and confirms the containers are gone before it drops the row', async () => {
      const { ownerSession, created } = await setUpRawCompose();

      const res = await request(server)
        .delete(`/compose/${created.composeId}?deleteVolumes=true`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(200);

      const commands = executedCommands();
      const teardown = commands.join('\n');
      expect(teardown).toContain(
        'docker network disconnect wp-stack cloudgate-traefik',
      );
      expect(teardown).toContain(
        'env -i PATH="$PATH" docker compose -p wp-stack down --volumes',
      );
      expect(teardown).toContain(`rm -rf ${platformRoot()}/compose/wp-stack`);

      // The read that makes the ordering mean something: it ran, it ran after
      // the teardown, and it named this stack's own project.
      expect(commands).toContain(presenceProbe('wp-stack'));
      expect(commands.findIndex(isPresenceProbe)).toBeGreaterThan(
        commands.findIndex((command) =>
          command.includes('docker compose -p wp-stack down'),
        ),
      );
      // Nothing to report: the containers were confirmed gone.
      expect(res.body).not.toHaveProperty('orphaned');

      expect(await composeRows(created.composeId)).toEqual([]);
    });

    /**
     * `docker compose … up -d --build` builds an image per
     * `build:` service and `docker compose … down` carries no `--rmi`, so
     * nothing in the product ever removed them: one image per service, on the
     * stack's own Server, under a name no row referred to any more once the
     * delete had run.
     *
     * The tag is `${appName}-${service}:latest` — measured on Docker 29.3.1 /
     * Compose v5.1.1, `compose/compose-images.ts` records the probe — and the
     * two shapes asserted here are the two the pure rule cannot show: that the
     * removals actually reach the machine on this route, and that they are
     * issued **after** the presence probe rather than before it, because
     * untagging ahead of a 409 would strip the image a still-running project is
     * using.
     */
    it('reclaims the images its own build produced, after the presence read', async () => {
      const { ownerSession, ownerCtx, created } = await setUpRawCompose();
      await compose.update(ownerCtx, created.composeId, {
        composeFile: `services:
  web:
    build: .
  db:
    image: mariadb:11
`,
      });

      const res = await request(server)
        .delete(`/compose/${created.composeId}`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(200);
      // Nothing left behind, so the field is absent rather than empty.
      expect(res.body).not.toHaveProperty('unreclaimedImages');

      const commands = executedCommands();
      // `quote()` escapes the tag's `:` on the way to the transport, so
      // the assertion is on the words rather than on `shell-quote`.
      const removal = commands.findIndex((command) =>
        /docker image rm wp-stack-web\\?:latest --force/.test(command),
      );
      expect(removal).toBeGreaterThan(-1);
      // `db` only pulls, so it is not named at all.
      expect(commands.join('\n')).not.toContain('wp-stack-db');
      expect(removal).toBeGreaterThan(commands.findIndex(isPresenceProbe));
    });

    it('names the images it could not reclaim and still drops the row', async () => {
      const { ownerSession, ownerCtx, created } = await setUpRawCompose();
      await compose.update(ownerCtx, created.composeId, {
        composeFile: 'services:\n  web:\n    build: .\n',
      });
      execMock.execAsync.mockImplementation((command: string) => {
        if (command.includes('docker image rm')) {
          return Promise.reject(new Error('daemon down'));
        }
        return teardownSucceeds(command);
      });

      const res = await request(server)
        .delete(`/compose/${created.composeId}`)
        .set('Cookie', ownerSession.cookie);

      // Reported, never refused: a leftover image is disk rather than
      // ADR-0008's unmanaged container, and *forget this stack* has to stay
      // completable while a machine is down (ADR-0016).
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        unreclaimedImages: [
          { serverId: null, images: ['wp-stack-web:latest'] },
        ],
      });
      expect(await composeRows(created.composeId)).toEqual([]);
    });

    /**
     * Network isolation's `<appName>` network is declared external in the
     * rewritten file, so `docker compose down` never removed it and every
     * isolated stack left one behind its delete. The teardown now removes it,
     * and the route asks again after the presence read — the retry a Swarm
     * stack needs once its tasks have left the overlay.
     */
    it("removes the stack's isolated network in the teardown and again after the presence read", async () => {
      const { ownerSession, created } = await setUpRawCompose();

      const res = await request(server)
        .delete(`/compose/${created.composeId}?deleteVolumes=true`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('unreclaimedArtifacts');

      const commands = executedCommands();
      const teardown = commands.findIndex((command) =>
        command.includes('docker compose -p wp-stack down'),
      );
      expect(commands[teardown]).toContain(
        'docker network rm wp-stack >/dev/null 2>&1 || true;',
      );
      const retry = commands.findIndex((command) =>
        command.startsWith('if docker network inspect wp-stack'),
      );
      expect(retry).toBeGreaterThan(commands.findIndex(isPresenceProbe));
    });

    it('reports the isolated network it could not remove and still drops the row', async () => {
      const { ownerSession, created } = await setUpRawCompose();
      execMock.execAsync.mockImplementation((command: string) => {
        if (command.startsWith('if docker network inspect wp-stack')) {
          return Promise.reject(
            new Error('network wp-stack has active endpoints'),
          );
        }
        return teardownSucceeds(command);
      });

      const res = await request(server)
        .delete(`/compose/${created.composeId}`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        unreclaimedArtifacts: expect.arrayContaining([
          {
            kind: 'network',
            appName: 'wp-stack',
            serverId: null,
            path: 'wp-stack',
          },
        ]) as unknown,
      });
      expect(await composeRows(created.composeId)).toEqual([]);
    });

    it('keeps the row and refuses the delete when the teardown fails and the containers are still there', async () => {
      const { ownerSession, created } = await setUpRawCompose();
      execMock.execAsync.mockImplementation((command: string) => {
        if (isPresenceProbe(command)) {
          return Promise.resolve({ ...ok, stdout: 'present\n' });
        }
        return Promise.reject(new Error('daemon down'));
      });

      const res = await request(server)
        .delete(`/compose/${created.composeId}`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toContain('wp-stack');

      // The whole point, from the two directions a test can reach it: the
      // record that names the still-running containers is still there, and the
      // route still answers for it — so the stack is still addressable as this
      // organization's Service rather than as an unmanaged orphan.
      expect(await composeRows(created.composeId)).toHaveLength(1);
      const found = await request(server)
        .get(`/compose/${created.composeId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(200);
    });

    /**
     * H-99. `docker stack rm` returns when the daemon *accepts* the removal, and
     * `docker stack ps --quiet` keeps naming tasks in `Shutdown` for several
     * seconds after that — so the probe answered `present` about the removal
     * this same request had just issued. Measured on the host, 3 trials of 3:
     * `409` at t+0, `409` at t+3, `200` at t+6/t+7. A `stack`-type compose could
     * not be deleted on the first attempt, ever.
     */
    it('deletes a stack whose tasks are still shutting down, on the first attempt (H-99)', async () => {
      const { ownerSession, ownerCtx, created } = await setUpRawCompose();
      await compose.update(ownerCtx, created.composeId, {
        composeType: 'stack',
      });
      // The host for the first seconds after the teardown: the swarm still names
      // a draining task, and the compose project never existed.
      let stackReads = 0;
      execMock.execAsync.mockImplementation((command: string) => {
        if (!isPresenceProbe(command)) return Promise.resolve(ok);
        const draining =
          command.includes('docker stack ps') && ++stackReads <= 2;
        return Promise.resolve({
          ...ok,
          stdout: draining ? 'present\n' : 'absent\n',
        });
      });

      const res = await request(server)
        .delete(`/compose/${created.composeId}`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('orphaned');
      expect(await composeRows(created.composeId)).toEqual([]);
      // It waited for the daemon to agree rather than deciding without it — and
      // it waited on the clock, not on a retry count.
      expect(settleSleeps).toHaveLength(2);
      expect(stackReads).toBe(3);
    });

    it('tells a stack to delete again in a moment, not to stop what this request already stopped (H-99)', async () => {
      const { ownerSession, ownerCtx, created } = await setUpRawCompose();
      await compose.update(ownerCtx, created.composeId, {
        composeType: 'stack',
      });
      execMock.execAsync.mockImplementation((command: string) =>
        Promise.resolve(
          isPresenceProbe(command)
            ? {
                ...ok,
                stdout: command.includes('docker stack ps')
                  ? 'present\n'
                  : 'absent\n',
              }
            : ok,
        ),
      );

      const res = await request(server)
        .delete(`/compose/${created.composeId}`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(409);
      const { message } = res.body as { message: string };
      // For a `stack` row `Stop` *is* `docker stack rm` — the command `remove`
      // ran one statement earlier — so the old first instruction advised the
      // action the request had already performed.
      expect(message).toContain('delete again in a moment');
      expect(message).not.toContain('stop it, then delete again');
      expect(message).toContain('?force=true');
      // A spent budget still refuses, and the row is still there.
      expect(settleElapsedMs).toBe(COMPOSE_SETTLE_BUDGET_MS);
      expect(await composeRows(created.composeId)).toHaveLength(1);
    });

    it('keeps telling a docker-compose project to stop first, which works for that branch (H-99)', async () => {
      const { ownerSession, created } = await setUpRawCompose();
      execMock.execAsync.mockImplementation((command: string) =>
        Promise.resolve(
          isPresenceProbe(command) ? { ...ok, stdout: 'present\n' } : ok,
        ),
      );

      const res = await request(server)
        .delete(`/compose/${created.composeId}`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(409);
      // `Stop` on this branch runs `docker compose stop`, after which the probe's
      // `ps --quiet` names nothing and the next delete goes through. The advice
      // is correct here and only here.
      expect((res.body as { message: string }).message).toContain(
        'stop it, then delete again',
      );
    });

    it('refuses when Docker cannot be reached, and force deletes while reporting what was left', async () => {
      const { ownerSession, created } = await setUpRawCompose();
      execMock.execAsync.mockRejectedValue(new Error('daemon down'));

      const refused = await request(server)
        .delete(`/compose/${created.composeId}`)
        .set('Cookie', ownerSession.cookie);
      expect(refused.status).toBe(409);
      // 'unknown', not 'gone': an unreachable daemon is the case where treating
      // a failure as absence is what manufactures the orphan.
      expect((refused.body as { message: string }).message).toContain(
        '?force=true',
      );
      expect(await composeRows(created.composeId)).toHaveLength(1);

      const forced = await request(server)
        .delete(`/compose/${created.composeId}?force=true`)
        .set('Cookie', ownerSession.cookie);
      expect(forced.status).toBe(200);
      // The answer names what was left behind rather than a bare 200 that says
      // the stack is gone when nobody established that.
      expect(forced.body).toMatchObject({
        orphaned: { appName: 'wp-stack', serverId: null, reason: 'unknown' },
      });
      expect(await composeRows(created.composeId)).toEqual([]);
    });

    it('asks the swarm about a stack-type compose as well as the compose project', async () => {
      const { ownerSession, ownerCtx, created } = await setUpRawCompose();
      await compose.update(ownerCtx, created.composeId, {
        composeType: 'stack',
      });

      const res = await request(server)
        .delete(`/compose/${created.composeId}`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(200);

      // A swarm stack has no compose project to `ps` and a compose project has
      // no stack to ask the swarm about, so these are two different questions —
      // and Delete is not entitled to pick one by the row's stored type, which
      // a caller may `PATCH` (H-87). It asks both and takes the pessimistic
      // answer.
      expect(executedCommands()).toContain(presenceProbe('wp-stack', 'stack'));
      expect(executedCommands()).toContain(presenceProbe('wp-stack'));
      expect(await composeRows(created.composeId)).toEqual([]);
    });

    /**
     * H-87, on the wire, in the shape the phase reproduced on the host: a
     * deployed `docker-compose` stack, one supported `PATCH` of its type, one
     * `DELETE` with no `?force`.
     *
     * Pre-fix that answered **200 with no `orphaned` key** and dropped the row
     * while `x08flip-web-1` stayed `Up` — row gone, workload alive, which is
     * precisely the state `applications.service.ts:322-326` says the
     * teardown→verify→row order makes impossible, and the bare 200 is a positive
     * claim that the teardown was confirmed. It was reachable because both
     * halves of that order — the teardown command and the presence probe — chose
     * their daemon subsystem from the same mutable column.
     */
    it('refuses the delete when the compose project is still up after its composeType was patched to stack (H-87)', async () => {
      const { ownerSession, ownerCtx, created } = await setUpRawCompose();
      await compose.update(ownerCtx, created.composeId, {
        composeType: 'stack',
      });
      // The host as it really is after the flip: the containers are a compose
      // project, and the swarm has never heard of this name.
      execMock.execAsync.mockImplementation((command: string) => {
        if (command === presenceProbe('wp-stack')) {
          return Promise.resolve({ ...ok, stdout: 'present\n' });
        }
        if (isPresenceProbe(command)) {
          return Promise.resolve({ ...ok, stdout: 'absent\n' });
        }
        return Promise.resolve(ok);
      });

      const res = await request(server)
        .delete(`/compose/${created.composeId}`)
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toContain('wp-stack');
      // The row is the only handle the product has on those containers, and it
      // is still there — so they are still this organization's Service rather
      // than an unmanaged orphan readable by every organization on the host
      // (ADR-0008).
      expect(await composeRows(created.composeId)).toHaveLength(1);

      // The other half of the finding: the teardown tried the right subsystem
      // too. Keying it off the patched column sent `docker stack rm` at a
      // compose project, where it failed into the route's `catch` and was never
      // seen — so a probe-only fix would 409 forever on a stack nothing ever
      // tried to stop.
      const teardown = executedCommands().join('\n');
      expect(teardown).toContain(
        'env -i PATH="$PATH" docker compose -p wp-stack down',
      );
      expect(teardown).toContain('docker stack rm wp-stack');
    });
  });
});
