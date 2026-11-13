import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  application,
  environment as environmentTable,
  licenseKey,
  member,
  mongo,
  mysql,
  organizationRole,
  plan as planTable,
  projectConfigLocation,
} from '../../src/db/schema';
import { parseProjectConfig } from '../../src/project-config';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { signUpMember } from '../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

interface PlanBody {
  planId: string;
  environmentId: string;
  source: string;
  status: string;
  textHash: string;
  settingsFingerprint: string;
  steps: Record<string, unknown>[];
  notes: Record<string, unknown>[];
  requestedBy: string | null;
  dismissedBy: string | null;
  dismissedAt: string | null;
}

/**
 * Every Project has a Cloudgate-kept Project config, and an operator can
 * ask for a Plan per Environment ("Check for changes"), see it, and dismiss
 * it. Nothing is applied here; Apply is tested on its own.
 */
describe('Project config and Plans (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let ownerId: string;
  let projectId: string;
  let environmentId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    const res = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    ownerId = (res.body as { user: { id: string } }).user.id;

    const project = await request(server)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'shop' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;

    const environment = await request(server)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ name: 'production', projectId });
    expect(environment.status).toBe(201);
    environmentId = (environment.body as { environmentId: string })
      .environmentId;

    // A console-made Application, Config name `shop`, on Cloudgate's defaults.
    const app = await request(server)
      .post('/applications')
      .set('Cookie', cookie)
      .send({ name: 'Shop', environmentId });
    expect(app.status).toBe(201);
    expect((app.body as { configName: string }).configName).toBe('shop');
  });

  /** Writes the stored Cloudgate-kept text, as an applied edit will. */
  async function storeConfig(text: string) {
    await ctx.db
      .update(projectConfigLocation)
      .set({ text })
      .where(eq(projectConfigLocation.projectId, projectId));
  }

  const askForPlan = (as = cookie) =>
    request(server)
      .post(`/environments/${environmentId}/plan`)
      .set('Cookie', as);

  const readPlan = (as = cookie) =>
    request(server)
      .get(`/environments/${environmentId}/plan`)
      .set('Cookie', as);

  const dismiss = (planId: string, as = cookie) =>
    request(server)
      .post(`/environments/${environmentId}/plan/dismiss`)
      .set('Cookie', as)
      .send({ planId });

  const CHANGES = `version: 1
services:
  shop:
    kind: web
    port: 8080
    env: [DATABASE_URL]
  cache:
    kind: redis
`;

  const openPlans = () =>
    ctx.db
      .select({ planId: planTable.planId })
      .from(planTable)
      .where(
        and(
          eq(planTable.environmentId, environmentId),
          eq(planTable.status, 'open'),
        ),
      );

  describe('the Project config', () => {
    it('starts a new Project with version 1 and no Services, kept in Cloudgate', async () => {
      // A Project of its own: `shop`'s already lists its console-made
      // Application.
      const created = await request(server)
        .post('/projects')
        .set('Cookie', cookie)
        .send({ name: 'blog' });
      expect(created.status).toBe(201);
      const blogId = (created.body as { projectId: string }).projectId;

      const res = await request(server)
        .get(`/projects/${blogId}/config`)
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      const body = res.body as {
        projectId: string;
        location: { kind: string; text: string; textHash: string };
      };
      expect(body.projectId).toBe(blogId);
      expect(body.location.kind).toBe('cloudgate');
      expect(body.location.textHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(parseProjectConfig(body.location.text)).toEqual({
        ok: true,
        config: { version: 1, services: {} },
      });
    });

    it('shows none for a Project from before configs existed, and refuses to plan it', async () => {
      await ctx.db
        .delete(projectConfigLocation)
        .where(eq(projectConfigLocation.projectId, projectId));
      // Nor the `save` plan of the console create above.
      await ctx.db
        .delete(planTable)
        .where(eq(planTable.environmentId, environmentId));

      const config = await request(server)
        .get(`/projects/${projectId}/config`)
        .set('Cookie', cookie);
      expect(config.status).toBe(200);
      expect(config.body).toEqual({ projectId, location: null });

      const asked = await askForPlan();
      expect(asked.status).toBe(409);
      expect((asked.body as { code: string }).code).toBe(
        'PROJECT_CONFIG_MISSING',
      );
      expect((await readPlan()).body).toEqual({ plan: null });
    });
  });

  describe('asking for a plan', () => {
    it('lists creates, changes with their fields, and notes, and keeps the plan open', async () => {
      await storeConfig(CHANGES);

      const res = await askForPlan();

      expect(res.status).toBe(201);
      const body = res.body as PlanBody;
      expect(body).toMatchObject({
        environmentId,
        source: 'request',
        status: 'open',
        requestedBy: ownerId,
      });
      expect(body.textHash).toMatch(/^sha256:/);
      expect(body.settingsFingerprint).toMatch(/^sha256:/);
      expect(body.steps).toEqual([
        {
          action: 'create',
          configName: 'cache',
          kind: 'redis',
          placement: { kind: 'platform-host' },
          fields: [],
        },
        expect.objectContaining({
          action: 'change',
          configName: 'shop',
          serviceType: 'application',
          name: 'Shop',
          fields: [{ field: 'port', from: 3000, to: 8080 }],
        }),
      ]);
      expect(body.notes).toEqual([
        expect.objectContaining({
          kind: 'variable-without-value',
          configName: 'shop',
          variable: 'DATABASE_URL',
        }),
      ]);

      expect((await readPlan()).body).toEqual({ plan: body });
    });

    it("places a Service it creates on the Environment's Deploy target", async () => {
      // jsonb with no foreign key, so the target need not resolve here.
      await ctx.db
        .update(environmentTable)
        .set({ deployTarget: { kind: 'server', serverId: 'srv-1' } })
        .where(eq(environmentTable.environmentId, environmentId));
      await storeConfig(CHANGES);

      const res = await askForPlan();

      expect((res.body as PlanBody).steps[0]).toMatchObject({
        action: 'create',
        configName: 'cache',
        placement: { kind: 'server', serverId: 'srv-1' },
      });
    });

    it('destroys a described Service an edit drops from the config', async () => {
      // The stored config describes `shop` (its console create wrote it);
      // an edit that drops it would delete `shop`.
      const res = await request(server)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', cookie)
        .send({ text: 'version: 1\nservices: {}\n' });

      expect(res.status).toBe(201);
      expect((res.body as { plans: PlanBody[] }).plans[0].steps).toEqual([
        expect.objectContaining({
          action: 'destroy',
          configName: 'shop',
          serviceType: 'application',
          name: 'Shop',
        }),
      ]);
    });

    it('notes a Service of a describable kind that the stored config never described, and destroys nothing', async () => {
      await storeConfig('version: 1\nservices: {}\n');

      const res = await askForPlan();

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'unchanged',
        steps: [],
        notes: [
          {
            kind: 'console-managed-unlisted',
            configName: 'shop',
            line: 'shop:\n  kind: web\n  managed: console',
          },
        ],
      });
    });

    it('never destroys a Service whose console-managed line is dropped, then or on a later plan', async () => {
      await storeConfig(
        'version: 1\nservices:\n  shop:\n    kind: web\n    managed: console\n',
      );

      const saved = await request(server)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', cookie)
        .send({ text: 'version: 1\nservices: {}\n' });

      expect(saved.status).toBe(201);
      expect(saved.body).toMatchObject({
        stored: true,
        plans: [
          {
            status: 'unchanged',
            steps: [],
            notes: [
              expect.objectContaining({
                kind: 'console-managed-dropped',
                configName: 'shop',
              }),
            ],
          },
        ],
      });
      const later = await askForPlan();
      expect(later.status).toBe(201);
      expect(later.body).toMatchObject({ status: 'unchanged', steps: [] });
    });

    it('notes a console-managed Service the config does not list, with the line to paste', async () => {
      await ctx.db.insert(mongo).values({
        name: 'Docs',
        configName: 'docs',
        databaseUser: 'docs',
        databasePassword: 'secret',
        environmentId,
      });
      await storeConfig('version: 1\nservices:\n  shop:\n    kind: web\n');

      const res = await askForPlan();

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'unchanged',
        steps: [],
        notes: [
          {
            kind: 'console-managed-unlisted',
            configName: 'docs',
            line: 'docs:\n  kind: mongo\n  managed: console',
          },
        ],
      });
    });

    it('notes on every plan that a console-managed MySQL can now be described', async () => {
      await ctx.db.insert(mysql).values({
        name: 'Shop DB',
        configName: 'shop-db',
        databaseName: 'shop',
        databaseUser: 'root',
        databasePassword: 'secret',
        databaseRootPassword: 'root-secret',
        dockerImage: 'mysql:8',
        environmentId,
      });
      await storeConfig(
        'version: 1\nservices:\n  shop:\n    kind: web\n  shop-db:\n    kind: mysql\n    managed: console\n',
      );
      const note = {
        kind: 'mysql-can-be-described',
        configName: 'shop-db',
        message:
          'shop-db: mysql can now be described; remove managed: console to hand it to the config',
      };

      for (let i = 0; i < 2; i++) {
        const res = await askForPlan();
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
          status: 'unchanged',
          steps: [],
          notes: [note],
        });
      }
    });

    it('replaces the open plan with a newer one', async () => {
      await storeConfig(CHANGES);
      const first = (await askForPlan()).body as PlanBody;

      const second = await askForPlan();

      expect(second.status).toBe(201);
      const newer = second.body as PlanBody;
      expect(newer.planId).not.toBe(first.planId);
      expect(newer.status).toBe('open');
      expect(await openPlans()).toEqual([{ planId: newer.planId }]);
      const [replaced] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.planId, first.planId));
      expect(replaced.status).toBe('superseded');
      expect(((await readPlan()).body as { plan: PlanBody }).plan.planId).toBe(
        newer.planId,
      );
    });

    it('says a plan with nothing to change does so, and does not keep it open', async () => {
      await storeConfig(CHANGES);
      const open = (await askForPlan()).body as PlanBody;
      await storeConfig('version: 1\nservices:\n  shop:\n    kind: web\n');

      const res = await askForPlan();

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'unchanged',
        steps: [],
        notes: [],
      });
      expect(await openPlans()).toEqual([]);
      const [replaced] = await ctx.db
        .select()
        .from(planTable)
        .where(eq(planTable.planId, open.planId));
      expect(replaced.status).toBe('superseded');
      expect(
        ((await readPlan()).body as { plan: PlanBody }).plan,
      ).toMatchObject({
        planId: (res.body as PlanBody).planId,
        status: 'unchanged',
      });
    });

    it('refuses a config it cannot plan, naming the Service, and leaves the open plan', async () => {
      await storeConfig(CHANGES);
      const open = (await askForPlan()).body as PlanBody;
      await ctx.db.insert(mongo).values({
        name: 'Docs',
        environmentId,
        configName: 'docs',
        databaseUser: 'docs',
        databasePassword: 'super-secret-mongo-password',
      });
      // A console-managed line the stored text already has is not checked
      // again; describing a kind version 1 cannot is refused anyway.
      await storeConfig(
        'version: 1\nservices:\n  shop:\n    kind: web\n  docs:\n    kind: postgres\n',
      );

      const res = await askForPlan();

      expect(res.status).toBe(409);
      const error = res.body as { code: string; message: string };
      expect(error.code).toBe('PLAN_REFUSED');
      expect(error.message).toContain('docs is a mongo Service');
      expect(await openPlans()).toEqual([{ planId: open.planId }]);
    });

    it('refuses a config that does not parse, naming the field', async () => {
      await storeConfig(
        'version: 1\nservices:\n  shop:\n    kind: web\n    prot: 80\n',
      );

      const res = await askForPlan();

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'PLAN_REFUSED',
        message: expect.stringContaining('shop.prot') as unknown,
      });
    });

    it('reads the Application port the config compares with from its own column', async () => {
      await ctx.db
        .update(application)
        .set({ port: 8080 })
        .where(eq(application.environmentId, environmentId));
      await storeConfig(
        'version: 1\nservices:\n  shop:\n    kind: web\n    port: 8080\n',
      );

      const res = await askForPlan();

      expect(res.body).toMatchObject({ status: 'unchanged', steps: [] });
    });
  });

  /**
   * A whole-YAML edit names the version it started from, and is refused
   * when Cloudgate's config has moved on since (ADR-0080), so a working copy
   * never undoes someone else's change.
   */
  describe('the config version', () => {
    interface LocationBody {
      kind: string;
      text: string;
      version: number;
      updatedAt: string;
    }

    async function readConfig(id = projectId) {
      const res = await request(server)
        .get(`/projects/${id}/config`)
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      return (res.body as { location: LocationBody }).location;
    }

    const editWhole = (body: { text: string; version?: number }) =>
      request(server)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', cookie)
        .send(body);

    it("answers a new Project's config as version 1, with its text", async () => {
      const created = await request(server)
        .post('/projects')
        .set('Cookie', cookie)
        .send({ name: 'blog' });
      expect(created.status).toBe(201);

      const location = await readConfig(
        (created.body as { projectId: string }).projectId,
      );

      expect(location).toMatchObject({ kind: 'cloudgate', version: 1 });
      expect(parseProjectConfig(location.text)).toEqual({
        ok: true,
        config: { version: 1, services: {} },
      });
    });

    it('refuses an edit that started from an older version, saying when the config last changed and who changed it', async () => {
      const started = await readConfig();
      // A teammate adds a Service in the console after the download.
      const teammate = await signUpMember(server, cookie, {
        name: 'Ida Rhodes',
        role: 'admin',
      });
      const added = await request(server)
        .post('/applications')
        .set('Cookie', teammate.cookie)
        .send({ name: 'Admin', environmentId });
      expect(added.status).toBe(201);
      const moved = await readConfig();
      expect(moved.version).not.toBe(started.version);

      const res = await editWhole({ text: CHANGES, version: started.version });

      expect(res.status).toBe(409);
      expect((res.body as { code: string }).code).toBe('CONFIG_VERSION_STALE');
      const message = (res.body as { message: string }).message;
      expect(message).toContain(`changed at ${moved.updatedAt} by Ida Rhodes`);
      expect(await openPlans()).toEqual([]);
      expect((await readConfig()).text).toBe(moved.text);
    });

    it('plans an edit that names the version it started from', async () => {
      const started = await readConfig();

      const res = await editWhole({ text: CHANGES, version: started.version });

      expect(res.status).toBe(201);
      expect(await openPlans()).toHaveLength(1);
    });

    it('plans an edit that names no version, whatever the config is at', async () => {
      await request(server)
        .post('/applications')
        .set('Cookie', cookie)
        .send({ name: 'Admin', environmentId });

      const res = await editWhole({ text: CHANGES });

      expect(res.status).toBe(201);
      expect(await openPlans()).toHaveLength(1);
    });

    it('moves the version when an edit with nothing to change stores its text', async () => {
      const started = await readConfig();

      const res = await editWhole({
        text: `# kept by hand\n${started.text}`,
        version: started.version,
      });

      expect(res.status).toBe(201);
      expect((res.body as { stored: boolean }).stored).toBe(true);
      const now = await readConfig();
      expect(now.version).not.toBe(started.version);
      expect(now.text).toBe(`# kept by hand\n${started.text}`);
    });

    it("keeps the version when an edit sends the stored text unchanged, so a teammate's copy is still current", async () => {
      const downloaded = await readConfig();
      const teammate = await signUpMember(server, cookie, {
        name: 'Ida Rhodes',
        role: 'admin',
      });
      const unchanged = await request(server)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', teammate.cookie)
        .send({ text: downloaded.text, version: downloaded.version });
      expect(unchanged.status).toBe(201);

      const res = await editWhole({
        text: CHANGES,
        version: downloaded.version,
      });

      expect(res.status).toBe(201);
      expect((await readConfig()).version).toBe(downloaded.version);
    });
  });

  describe('dismissing a plan', () => {
    it('dismisses the open plan, recording who and when', async () => {
      await storeConfig(CHANGES);
      const open = (await askForPlan()).body as PlanBody;

      const res = await dismiss(open.planId);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        planId: open.planId,
        status: 'dismissed',
        dismissedBy: ownerId,
      });
      expect((res.body as PlanBody).dismissedAt).toEqual(expect.any(String));
      expect(await openPlans()).toEqual([]);
    });

    it('refuses a plan that is no longer open, and one that does not exist', async () => {
      await storeConfig(CHANGES);
      const first = (await askForPlan()).body as PlanBody;
      await askForPlan();

      const replaced = await dismiss(first.planId);
      expect(replaced.status).toBe(409);
      expect((replaced.body as { code: string }).code).toBe('PLAN_NOT_OPEN');

      expect((await dismiss('no-such-plan')).status).toBe(404);
    });
  });

  describe('statements', () => {
    /** A member holding a licensed custom role with exactly these statements. */
    async function memberWith(environmentActions: string[]) {
      const fixture = await signUpMember(server, cookie);
      const [row] = await ctx.db
        .select({ organizationId: member.organizationId })
        .from(member)
        .where(eq(member.userId, ownerId));
      await ctx.db.insert(licenseKey).values({
        organizationId: row.organizationId,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });
      await ctx.db.insert(organizationRole).values({
        organizationId: row.organizationId,
        role: 'plan-reader',
        permission: { environment: environmentActions },
      });
      await ctx.db
        .update(member)
        .set({
          role: 'plan-reader',
          accessedProjects: [projectId],
          accessedEnvironments: [environmentId],
        })
        .where(eq(member.userId, fixture.id));
      return fixture.cookie;
    }

    it('lets environment: read see and ask for a plan, but not dismiss one', async () => {
      await storeConfig(CHANGES);
      const reader = await memberWith(['read']);

      const asked = await askForPlan(reader);
      expect(asked.status).toBe(201);
      expect((await readPlan(reader)).status).toBe(200);

      const dismissed = await dismiss((asked.body as PlanBody).planId, reader);
      expect(dismissed.status).toBe(403);
      expect(await openPlans()).toHaveLength(1);
    });

    it('refuses seeing or asking for a plan without environment: read', async () => {
      const outsider = await memberWith([]);

      expect((await askForPlan(outsider)).status).toBe(403);
      expect((await readPlan(outsider)).status).toBe(403);
    });

    it('lets environment: update dismiss', async () => {
      await storeConfig(CHANGES);
      const editor = await memberWith(['read', 'update']);
      const open = (await askForPlan()).body as PlanBody;

      expect((await dismiss(open.planId, editor)).status).toBe(200);
    });
  });
});
