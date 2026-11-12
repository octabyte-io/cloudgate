import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { member, mount, server as serverTable } from '../../src/db/schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RegistriesService } from '../../src/registries/registries.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
/**
 * Whether a command is the presence probe Delete issues. Matched by its
 * three-branch shell shape rather than by the question inside it, and both ends
 * are checked: a `startsWith('docker service inspect ')` discriminator was what
 * H-104 was, because H-95 moved the question behind an `if ! docker version`
 * reachability branch and this file's copy of the discriminator was not
 * updated, so it matched nothing, the probe answered `''`,
 * `readWorkloadPresence` read that as `'unknown'` and three deletes here 409'd.
 *
 * Hand-written rather than imported from `application-ops.ts`, and now one copy
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

describe('Applications (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let registries: RegistriesService;
  let applications: ApplicationsService;

  /**
   * Delete reaches the exec layer and the Traefik writer, so both
   * are doubles here: without them `DELETE /applications/:id` would shell out
   * on the machine running the suite. The presence read answers `absent`, the
   * happy path — an empty stdout is `'unknown'` on purpose and would 409.
   */
  const ok = { stdout: '', stderr: '', exitCode: 0 };
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
  const teardownSucceeds = (command: string) =>
    Promise.resolve(
      isPresenceProbe(command) ? { ...ok, stdout: 'absent' } : ok,
    );

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
    registries = ctx.app.get(RegistriesService);
    applications = ctx.app.get(ApplicationsService);
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

  /** An owner ctx plus a project + environment for applications to attach to. */
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
    it('creates an application retrievable with deep relations', async () => {
      const { ownerCtx, project, environment } = await setUpEnvironment();

      const created = await applications.create(ownerCtx, {
        name: 'Web App',
        appName: 'web-app',
        description: 'the web frontend',
        environmentId: environment.environmentId,
      });

      expect(created.applicationId).toEqual(expect.any(String));
      expect(created.appName).toBe('web-app');
      expect(created.applicationStatus).toBe('idle');
      expect(created.sourceType).toBe('github');
      expect(created.buildType).toBe('nixpacks');

      const found = await applications.findOne(ownerCtx, created.applicationId);
      expect(found).toMatchObject({
        applicationId: created.applicationId,
        name: 'Web App',
        description: 'the web frontend',
        environmentId: environment.environmentId,
      });
      expect(found.environment.projectId).toBe(project.projectId);
      expect(found.environment.project.projectId).toBe(project.projectId);
      expect(found.registry).toBeNull();
    });

    it('generates a valid appName when none is given', async () => {
      const { ownerCtx, environment } = await setUpEnvironment();

      const created = await applications.create(ownerCtx, {
        name: 'Unnamed',
        environmentId: environment.environmentId,
      });

      expect(created.appName).toMatch(/^app-[a-z0-9._-]+$/);
    });

    it('stores env, buildArgs and buildSecrets encrypted at rest, returned decrypted', async () => {
      const { ownerCtx, environment } = await setUpEnvironment();

      const created = await applications.create(ownerCtx, {
        name: 'Secretive',
        environmentId: environment.environmentId,
      });

      await applications.saveEnvironment(ownerCtx, created.applicationId, {
        env: 'DB_PASSWORD=super-secret',
        buildArgs: 'ARG_TOKEN=build-secret',
        buildSecrets: 'SECRET_KEY=hush-hush',
      });

      const found = await applications.findOne(ownerCtx, created.applicationId);
      expect(found.env).toBe('DB_PASSWORD=super-secret');
      expect(found.buildArgs).toBe('ARG_TOKEN=build-secret');
      expect(found.buildSecrets).toBe('SECRET_KEY=hush-hush');

      const raw = await ctx.db.$client.query<{
        env: string;
        build_args: string;
        build_secrets: string;
      }>(
        'select env, build_args, build_secrets from application where application_id = $1',
        [created.applicationId],
      );
      const stored = [
        [raw.rows[0].env, 'super-secret'],
        [raw.rows[0].build_args, 'build-secret'],
        [raw.rows[0].build_secrets, 'hush-hush'],
      ] as const;
      for (const [value, plaintext] of stored) {
        expect(value).not.toContain(plaintext);
        expect(value.startsWith('enc:v1:')).toBe(true);
      }
    });

    it('rejects a duplicate appName', async () => {
      const { ownerCtx, environment } = await setUpEnvironment();

      await applications.create(ownerCtx, {
        name: 'First',
        appName: 'taken-name',
        environmentId: environment.environmentId,
      });

      await expect(
        applications.create(ownerCtx, {
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

      const created = await applications.create(ownerCtx, {
        name: 'before',
        appName: 'stable-name',
        environmentId: environment.environmentId,
      });
      await applications.saveEnvironment(ownerCtx, created.applicationId, {
        env: 'API_KEY=untouched',
      });

      const updated = await applications.update(
        ownerCtx,
        created.applicationId,
        {
          name: 'after',
          sourceType: 'docker',
          dockerImage: 'nginx:alpine',
          buildType: 'dockerfile',
          dockerfile: 'docker/Dockerfile',
          replicas: 3,
        },
      );
      expect(updated).toMatchObject({
        applicationId: created.applicationId,
        name: 'after',
        appName: 'stable-name',
        sourceType: 'docker',
        dockerImage: 'nginx:alpine',
        buildType: 'dockerfile',
        dockerfile: 'docker/Dockerfile',
        replicas: 3,
      });

      const found = await applications.findOne(ownerCtx, created.applicationId);
      expect(found.name).toBe('after');
      expect(found.env).toBe('API_KEY=untouched');
      expect(found.appName).toBe('stable-name');
    });

    /**
     * `buildServerId` is the one Server reference `update`
     * accepts — `updateApplicationSchema` is `createSchema.partial()` minus
     * `serverId` — and it reached the same foreign key as create's `serverId`
     * and answered the same 500 on the same table. The class-wide pin for the
     * nine create routes lives in
     * `test/servers/create-routes-server-id.e2e-spec.ts`; this is the
     * neighbouring route, where a reviewer of this module will look.
     */
    describe('buildServerId', () => {
      /** A real `server` row in the organization named. */
      async function insertServer(organizationId: string, name: string) {
        const [row] = await ctx.db
          .insert(serverTable)
          .values({
            name,
            ipAddress: '203.0.113.7',
            port: 22,
            organizationId,
          })
          .returning();
        return row;
      }

      it('refuses an unknown buildServerId with 404 rather than 500', async () => {
        const { ownerCtx, ownerSession, environment } =
          await setUpEnvironment();
        const created = await applications.create(ownerCtx, {
          name: 'built-elsewhere',
          environmentId: environment.environmentId,
        });

        const res = await request(server)
          .patch(`/applications/${created.applicationId}`)
          .set('Cookie', ownerSession.cookie)
          .send({ buildServerId: 'w03nonexistentid00000' });

        expect(res.status).toBe(404);
        expect((res.body as { message: string }).message).toBe(
          'Server not found',
        );
        const found = await applications.findOne(
          ownerCtx,
          created.applicationId,
        );
        expect(found.buildServerId).toBeNull();
      });

      it('refuses a buildServerId in another organization with the same 404', async () => {
        const { ownerCtx, ownerSession, environment } =
          await setUpEnvironment();
        const created = await applications.create(ownerCtx, {
          name: 'built-elsewhere',
          environmentId: environment.environmentId,
        });

        // A real row in a second organization, not an id nothing owns: one
        // lookup raises the same NotFound whichever predicate misses, so a
        // dangling id cannot tell a passing organization check from one that
        // never ran. This is also the only case that reaches the
        // foreign key's blind spot — `application.build_server_id →
        // server.server_id` names no organization column, so before the fix
        // this id satisfied the constraint and the row went in.
        const other = await createOrganization(
          server,
          ctx.db,
          ownerSession.cookie,
          { name: 'other-tenant', slug: `other-${Date.now()}` },
        );
        const theirs = await insertServer(
          (other.body as { id: string }).id,
          'not-yours',
        );

        const res = await request(server)
          .patch(`/applications/${created.applicationId}`)
          .set('Cookie', ownerSession.cookie)
          .send({ buildServerId: theirs.serverId });

        expect(res.status).toBe(404);
        expect((res.body as { message: string }).message).toBe(
          'Server not found',
        );
        const found = await applications.findOne(
          ownerCtx,
          created.applicationId,
        );
        expect(found.buildServerId).toBeNull();
      });

      it('accepts a buildServerId this organization owns, and null to clear it', async () => {
        const { organizationId, ownerCtx, ownerSession, environment } =
          await setUpEnvironment();
        const created = await applications.create(ownerCtx, {
          name: 'built-elsewhere',
          environmentId: environment.environmentId,
        });
        const ours = await insertServer(organizationId, 'build-box');

        const set = await request(server)
          .patch(`/applications/${created.applicationId}`)
          .set('Cookie', ownerSession.cookie)
          .send({ buildServerId: ours.serverId });
        expect(set.status).toBe(200);
        expect((set.body as { buildServerId: string }).buildServerId).toBe(
          ours.serverId,
        );

        // Clearing the build server is a legitimate operation and must stay
        // one: `checkServerAccess`'s absent-id branch resolves to undefined
        // rather than throwing, which is ADR-0008's platform-host contract.
        const cleared = await request(server)
          .patch(`/applications/${created.applicationId}`)
          .set('Cookie', ownerSession.cookie)
          .send({ buildServerId: null });
        expect(cleared.status).toBe(200);
        expect(
          (cleared.body as { buildServerId: string | null }).buildServerId,
        ).toBeNull();
      });
    });

    it('carries the preview deployment settings, defaulted to three previews on port 3000', async () => {
      const { ownerCtx, environment } = await setUpEnvironment();

      const created = await applications.create(ownerCtx, {
        name: 'previewed',
        environmentId: environment.environmentId,
      });
      // A repository gets three previews and a container on 3000 until it
      // says otherwise.
      expect(created.previewLimit).toBe(3);
      expect(created.previewPort).toBe(3000);
      expect(created.previewEnv).toBeNull();
      expect(created.previewBuildArgs).toBeNull();

      const updated = await applications.update(
        ownerCtx,
        created.applicationId,
        {
          previewLimit: 5,
          previewPort: 8080,
          previewEnv: 'DATABASE_URL=staging-db-host',
          previewBuildArgs: 'API_HOST=api.staging.example.com',
        },
      );
      expect(updated).toMatchObject({
        previewLimit: 5,
        previewPort: 8080,
        previewEnv: 'DATABASE_URL=staging-db-host',
        previewBuildArgs: 'API_HOST=api.staging.example.com',
      });

      const found = await applications.findOne(ownerCtx, created.applicationId);
      expect(found.previewLimit).toBe(5);
      expect(found.previewPort).toBe(8080);

      // The two variable columns are encrypted at rest, like env/buildArgs.
      const raw = await ctx.db.$client.query<{
        preview_env: string;
        preview_build_args: string;
      }>(
        'select preview_env, preview_build_args from application where application_id = $1',
        [created.applicationId],
      );
      for (const [value, plaintext] of [
        [raw.rows[0].preview_env, 'staging-db-host'],
        [raw.rows[0].preview_build_args, 'api.staging.example.com'],
      ] as const) {
        expect(value).not.toContain(plaintext);
        expect(value.startsWith('enc:v1:')).toBe(true);
      }
    });

    it('rejects a preview limit or port outside its range', async () => {
      const { ownerCtx, ownerSession, environment } = await setUpEnvironment();
      const created = await applications.create(ownerCtx, {
        name: 'previewed',
        environmentId: environment.environmentId,
      });

      for (const body of [{ previewLimit: -1 }, { previewPort: 70000 }]) {
        const res = await request(server)
          .patch(`/applications/${created.applicationId}`)
          .set('Cookie', ownerSession.cookie)
          .send(body);
        expect(res.status).toBe(400);
      }
    });

    it('attaches a registry, whose password findOne strips', async () => {
      const { ownerCtx, environment } = await setUpEnvironment();

      const registry = await registries.create(ownerCtx, {
        name: 'docker-hub',
        username: 'grace',
        password: 'registry-secret',
        url: '',
        registryType: 'cloud',
      });
      const created = await applications.create(ownerCtx, {
        name: 'registered',
        environmentId: environment.environmentId,
      });

      await applications.update(ownerCtx, created.applicationId, {
        registryId: registry.registryId,
      });

      const found = await applications.findOne(ownerCtx, created.applicationId);
      expect(found.registry).toMatchObject({
        registryId: registry.registryId,
        username: 'grace',
      });
      expect(found.registry).not.toHaveProperty('password');
    });
  });

  describe('updateStatus', () => {
    it('transitions applicationStatus through the deploy lifecycle', async () => {
      const { ownerCtx, environment } = await setUpEnvironment();

      const created = await applications.create(ownerCtx, {
        name: 'deployable',
        environmentId: environment.environmentId,
      });
      expect(created.applicationStatus).toBe('idle');

      await applications.updateStatus(created.applicationId, 'running');
      let found = await applications.findOne(ownerCtx, created.applicationId);
      expect(found.applicationStatus).toBe('running');

      await applications.updateStatus(created.applicationId, 'error');
      found = await applications.findOne(ownerCtx, created.applicationId);
      expect(found.applicationStatus).toBe('error');
    });
  });

  describe('findDeployable', () => {
    /**
     * `mounts` came off `select().from(mount)` — whole
     * rows — against a field declared `ServiceMount[]`, five fields and no
     * `content`, and `mount.content` is an `encryptedText` column holding the
     * body of a file mount. So the decrypted body of an operator's config file
     * rode along on every consumer of a `DeployableApplication`, and an earlier fix found
     * it persisted in `rollback.full_context` and served over HTTP.
     *
     * The row is inserted with drizzle rather than through
     * `MountsService.create`, which also writes the file onto the build server
     * and is `mounts.e2e-spec.ts`' subject. What is under test here is what a
     * *stored* row does on the way back out.
     *
     * This is the half `deployable-relation-projections.spec.ts` cannot make:
     * that one reads the column list the service hands `db.select()`, and
     * asserting Postgres honours it needs Postgres. The two `content` reads
     * below are also what stop this from being a test that cannot fail — a
     * mount row with an empty `content`, or an `encryptedText` column that
     * silently stopped round-tripping, would pass the absence assertion for the
     * wrong reason.
     */
    it('projects mounts to the five declared fields, so a file mount body never leaves the seam', async () => {
      const { ownerCtx, environment } = await setUpEnvironment();
      const created = await applications.create(ownerCtx, {
        name: 'mounted',
        environmentId: environment.environmentId,
      });
      const body = 'aws_secret_access_key = wJalrXUtnFEMI';

      await ctx.db.insert(mount).values({
        type: 'file',
        mountPath: '/app/credentials',
        filePath: 'credentials',
        content: body,
        applicationId: created.applicationId,
      });

      // The column really is ciphertext at rest and really does decrypt, so
      // the body was reachable and its absence below is the projection's doing.
      const raw = await ctx.db.$client.query<{ content: string }>(
        'select content from mount where application_id = $1',
        [created.applicationId],
      );
      expect(raw.rows[0].content).not.toContain('wJalrXUtnFEMI');
      const [whole] = await ctx.db
        .select()
        .from(mount)
        .where(eq(mount.applicationId, created.applicationId));
      expect(whole.content).toBe(body);

      const deployable = await applications.findDeployable(
        created.applicationId,
      );

      expect(deployable.mounts).toEqual([
        {
          type: 'file',
          mountPath: '/app/credentials',
          filePath: 'credentials',
          volumeName: null,
          hostPath: null,
        },
      ]);
      // Named as well as implied by the deep equality: `content` is the column
      // found in a rollback snapshot, and `mountId` and the eight parent ids are
      // the rest of what a whole row carried into one.
      expect(Object.keys(deployable.mounts?.[0] ?? {}).sort()).toEqual([
        'filePath',
        'hostPath',
        'mountPath',
        'type',
        'volumeName',
      ]);
    });
  });

  describe('remove', () => {
    it('deletes the application', async () => {
      const { ownerCtx, environment } = await setUpEnvironment();

      const created = await applications.create(ownerCtx, {
        name: 'doomed',
        environmentId: environment.environmentId,
      });

      const removed = await applications.remove(
        ownerCtx,
        created.applicationId,
      );
      expect(removed.applicationId).toBe(created.applicationId);

      await expect(
        applications.findOne(ownerCtx, created.applicationId),
      ).rejects.toThrow(NotFoundException);
    });

    it('removing the parent environment cascades its applications', async () => {
      const { ownerCtx, environment } = await setUpEnvironment();

      const created = await applications.create(ownerCtx, {
        name: 'cascaded',
        environmentId: environment.environmentId,
      });

      await environments.remove(ownerCtx, environment.environmentId);

      const raw = await ctx.db.$client.query(
        'select application_id from application where application_id = $1',
        [created.applicationId],
      );
      expect(raw.rows).toEqual([]);
    });
  });

  describe('permissions and isolation', () => {
    it('create grants the creator row-level access', async () => {
      const { ownerSession, organizationId, environment } =
        await setUpEnvironment();
      const admin = await inviteUser(
        server,
        ownerSession.cookie,
        'admin@example.com',
        'admin',
      );
      const adminCtx = permissionCtx(admin.id, organizationId);

      const own = await applications.create(adminCtx, {
        name: 'admins-app',
        environmentId: environment.environmentId,
      });

      // Downgrade the creator to a plain member: only the row-level grant
      // made at create time can keep their application visible.
      await ctx.db
        .update(member)
        .set({ role: 'member' })
        .where(eq(member.userId, admin.id));

      const found = await applications.findOne(adminCtx, own.applicationId);
      expect(found.applicationId).toBe(own.applicationId);
    });

    it('a member without a row-level grant cannot read an application in their own organization', async () => {
      const { ownerSession, ownerCtx, organizationId, environment } =
        await setUpEnvironment();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );
      const inviteeCtx = permissionCtx(invitee.id, organizationId);

      const created = await applications.create(ownerCtx, {
        name: 'ungranted',
        environmentId: environment.environmentId,
      });

      await expect(
        applications.findOne(inviteeCtx, created.applicationId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('a member cannot create an application', async () => {
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
        applications.create(inviteeCtx, {
          name: 'not-allowed',
          environmentId: environment.environmentId,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('an application is invisible outside its own organization', async () => {
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
      const orgBApp = await applications.create(secondOrgCtx, {
        name: 'org-b-app',
        environmentId: orgBEnv.environmentId,
      });

      // Same user, but acting in the first organization: the application
      // from the second organization must not resolve, even for its creator.
      const firstOrg = await request(server)
        .get('/organizations')
        .set('Cookie', ownerSession.cookie);
      const firstOrgId = (firstOrg.body as { id: string }[]).find(
        (o) => o.id !== secondOrgId,
      )!.id;
      const firstOrgCtx = permissionCtx(ownerSession.id, firstOrgId);

      await expect(
        applications.findOne(firstOrgCtx, orgBApp.applicationId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        applications.create(firstOrgCtx, {
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
        .post('/applications')
        .set('Cookie', cookie)
        .send({
          name: 'web',
          appName: 'web-over-http',
          environmentId: environment.environmentId,
        });
      expect(created.status).toBe(201);
      const id = (created.body as { applicationId: string }).applicationId;

      const one = await request(server)
        .get(`/applications/${id}`)
        .set('Cookie', cookie);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        name: 'web',
        appName: 'web-over-http',
      });

      const patched = await request(server)
        .patch(`/applications/${id}`)
        .set('Cookie', cookie)
        .send({ name: 'web-renamed', replicas: 2 });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ name: 'web-renamed', replicas: 2 });

      const savedEnv = await request(server)
        .patch(`/applications/${id}/environment`)
        .set('Cookie', cookie)
        .send({ env: 'A=1' });
      expect(savedEnv.status).toBe(200);
      expect(savedEnv.body).toMatchObject({ env: 'A=1' });

      const removed = await request(server)
        .delete(`/applications/${id}`)
        .set('Cookie', cookie);
      expect(removed.status).toBe(200);

      const gone = await request(server)
        .get(`/applications/${id}`)
        .set('Cookie', cookie);
      expect(gone.status).toBe(404);
    });

    it('POST /applications returns 403 for a member and 201 for the owner', async () => {
      const { ownerSession, environment } = await setUpEnvironment();
      const invitee = await inviteUser(
        server,
        ownerSession.cookie,
        'invitee@example.com',
        'member',
      );

      const denied = await request(server)
        .post('/applications')
        .set('Cookie', invitee.cookie)
        .send({
          name: 'not-allowed',
          environmentId: environment.environmentId,
        });
      expect(denied.status).toBe(403);

      const allowed = await request(server)
        .post('/applications')
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'allowed', environmentId: environment.environmentId });
      expect(allowed.status).toBe(201);
      expect(allowed.body).toMatchObject({ name: 'allowed' });
    });
  });
});
