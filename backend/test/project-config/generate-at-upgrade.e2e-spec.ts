import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  application,
  deployment,
  mongo,
  mysql,
  plan as planTable,
  postgres,
  projectConfigLocation,
  redis,
  webServerSettings,
} from '../../src/db/schema';
import {
  ConfigGenerationService,
  parseProjectConfig,
} from '../../src/project-config';
import { seededConfigName } from '../utils/seeded-config-name';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/**
 * At upgrade, every Project without a config gets a generated,
 * Cloudgate-kept one whose first plan in every Environment changes nothing —
 * asserted here on seeded rows, as the upgrade would find them, with no
 * Deployment queued and no row changed beyond the config location.
 */
describe('Project config generation at upgrade (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;

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
    await ctx.db.insert(webServerSettings).values({ serverIp: '203.0.113.7' });
  });

  const generateMissing = () =>
    ctx.app.get(ConfigGenerationService).generateMissing();

  async function createProject(name: string, environments: string[]) {
    const created = await request(server)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name });
    expect(created.status).toBe(201);
    const projectId = (created.body as { projectId: string }).projectId;
    const ids: string[] = [];
    for (const environment of environments) {
      const made = await request(server)
        .post('/environments')
        .set('Cookie', cookie)
        .send({ name: environment, projectId });
      expect(made.status).toBe(201);
      ids.push((made.body as { environmentId: string }).environmentId);
    }
    return { projectId, environmentIds: ids };
  }

  /** A Project as it was before configs existed: no config location row. */
  async function seedLegacyProject() {
    const { projectId, environmentIds } = await createProject('shop', [
      'production',
      'staging',
    ]);
    const [production, staging] = environmentIds;
    await ctx.db
      .delete(projectConfigLocation)
      .where(eq(projectConfigLocation.projectId, projectId));

    // One Config name per Service, the same in each Environment it is in.
    const names = {
      shop: seededConfigName(),
      db: seededConfigName(),
      cache: seededConfigName(),
      api: seededConfigName(),
      legacy: seededConfigName(),
      worker: seededConfigName(),
      docs: seededConfigName(),
    };
    for (const [environmentId, extra] of [
      [production, 'SENTRY_DSN'],
      [staging, 'DEBUG'],
    ] as const) {
      await ctx.db.insert(application).values([
        {
          name: 'Shop',
          environmentId,
          configName: names.shop,
          sourceType: 'github',
          owner: 'acme',
          repository: 'shop',
          buildType: 'dockerfile',
          port: 8080,
          cpuLimit: '500000000',
          memoryLimit: '1073741824',
          env: `DATABASE_URL=postgres://x\n${extra}=1\n`,
        },
        {
          name: 'API',
          environmentId,
          configName: names.api,
          sourceType: 'docker',
          dockerImage: 'acme/api:1',
          dockerfile: environmentId === production ? 'Dockerfile' : 'Dev',
        },
        {
          name: 'Legacy',
          environmentId,
          configName: names.legacy,
          sourceType: 'git',
          customGitUrl: 'https://deploy:s3cr3t-token@git.example.com/a/b.git',
        },
      ]);
      await ctx.db.insert(postgres).values({
        name: 'DB',
        environmentId,
        configName: names.db,
        dockerImage: 'postgres:16',
        databaseName: environmentId === production ? 'shop' : 'shop_staging',
        databaseUser: 'shop',
        databasePassword: 'super-secret-database-password',
      });
      await ctx.db.insert(redis).values({
        name: 'Cache',
        environmentId,
        configName: names.cache,
        databasePassword: 'super-secret-redis-password',
        cpuLimit: environmentId === production ? '1000000000' : null,
      });
    }
    // Only in production: an Application, and a kind version 1 cannot describe.
    await ctx.db.insert(application).values({
      name: 'Worker',
      environmentId: production,
      configName: names.worker,
      sourceType: 'docker',
      dockerImage: 'acme/worker:1',
    });
    await ctx.db.insert(mongo).values({
      name: 'Docs',
      environmentId: production,
      configName: names.docs,
      databaseUser: 'docs',
      databasePassword: 'super-secret-mongo-password',
    });
    return { projectId, environmentIds, names };
  }

  /** Every row generation must not touch. */
  const snapshot = async () => ({
    applications: await ctx.db
      .select()
      .from(application)
      .orderBy(application.applicationId),
    postgres: await ctx.db.select().from(postgres).orderBy(postgres.postgresId),
    redis: await ctx.db.select().from(redis).orderBy(redis.redisId),
    mongo: await ctx.db.select().from(mongo).orderBy(mongo.mongoId),
    deployments: await ctx.db.select().from(deployment),
  });

  const readConfig = async (projectId: string) => {
    const res = await request(server)
      .get(`/projects/${projectId}/config`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { location: { kind: string; text: string } | null })
      .location;
  };

  it('generates a Cloudgate-kept config whose first plan changes nothing in every Environment', async () => {
    const { projectId, environmentIds, names } = await seedLegacyProject();
    const before = await snapshot();

    expect(await generateMissing()).toBe(1);

    // Nothing but the config and its generate plans was written: no
    // Service, no Deployment.
    expect(await snapshot()).toEqual(before);
    expect(before.deployments).toEqual([]);
    // Each Environment's first plan is the generation's own, with nothing
    // to change, so none is left open.
    const generatedPlans = await ctx.db.select().from(planTable);
    expect(
      generatedPlans.map((one) => [one.environmentId, one.source, one.status]),
    ).toEqual(
      expect.arrayContaining(
        environmentIds.map((id) => [id, 'generate', 'unchanged']),
      ),
    );
    expect(generatedPlans).toHaveLength(environmentIds.length);
    for (const one of generatedPlans) expect(one.steps).toEqual([]);

    const location = await readConfig(projectId);
    expect(location?.kind).toBe('cloudgate');
    const text = location!.text;
    expect(text.split('\n')[0]).toMatch(
      /^# yaml-language-server: \$schema=http:\/\/203\.0\.113\.7:\d+\/backend\/schema\/project-config\/v1\.json$/,
    );
    expect(text).not.toContain('s3cr3t-token');
    expect(text).not.toContain('postgres://x');

    const parsed = parseProjectConfig(text);
    if (!parsed.ok) throw new Error(parsed.refusal.message);
    expect(parsed.config.services).toMatchObject({
      [names.shop]: {
        kind: 'web',
        size: { name: 'small' },
        port: 8080,
        env: ['DATABASE_URL', 'SENTRY_DSN', 'DEBUG'],
      },
      // Their Environments disagree on the database name, and on the caps.
      [names.db]: { kind: 'postgres', managed: 'console' },
      [names.cache]: { kind: 'redis', managed: 'console' },
      [names.api]: { kind: 'web', managed: 'console' },
      [names.legacy]: { kind: 'web', managed: 'console' },
      [names.worker]: { kind: 'web', managed: 'console' },
      [names.docs]: { kind: 'mongo', managed: 'console' },
    });
    expect(text).toMatch(/disagree on database/);
    expect(text).toMatch(/disagree on size/);

    for (const environmentId of environmentIds) {
      const asked = await request(server)
        .post(`/environments/${environmentId}/plan`)
        .set('Cookie', cookie);
      expect(asked.status).toBe(201);
      expect(asked.body).toMatchObject({ status: 'unchanged', steps: [] });
    }
    expect(await ctx.db.select().from(deployment)).toEqual([]);
  });

  it('is idempotent and leaves a Project that already has a config alone', async () => {
    const { projectId } = await seedLegacyProject();
    const kept = await createProject('blog', ['production']);
    const keptBefore = await readConfig(kept.projectId);

    expect(await generateMissing()).toBe(1);
    const generated = await readConfig(projectId);
    expect(await generateMissing()).toBe(0);

    expect(await readConfig(projectId)).toEqual(generated);
    expect(await readConfig(kept.projectId)).toEqual(keptBefore);
  });

  it('leaves a config listing a console-managed MySQL byte-for-byte as it was, and its plans only note that it can now be described', async () => {
    const { projectId, environmentIds } = await createProject('shop', [
      'production',
    ]);
    await ctx.db.insert(mysql).values({
      name: 'Shop DB',
      configName: 'shop-db',
      databaseName: 'shop',
      databaseUser: 'root',
      databasePassword: 'secret',
      databaseRootPassword: 'root-secret',
      dockerImage: 'mysql:8',
      environmentId: environmentIds[0],
    });
    const text =
      'version: 1\nservices:\n  # Version 1 cannot describe a mysql Service, so the console keeps it.\n  shop-db:\n    kind: mysql\n    managed: console\n';
    await ctx.db
      .update(projectConfigLocation)
      .set({ text })
      .where(eq(projectConfigLocation.projectId, projectId));

    expect(await generateMissing()).toBe(0);
    const asked = await request(server)
      .post(`/environments/${environmentIds[0]}/plan`)
      .set('Cookie', cookie);

    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({
      status: 'unchanged',
      steps: [],
      notes: [{ kind: 'mysql-can-be-described', configName: 'shop-db' }],
    });
    expect((await readConfig(projectId))?.text).toBe(text);
    const [row] = await ctx.db.select().from(mysql);
    expect(row).toMatchObject({ dockerImage: 'mysql:8', configPlanId: null });
  });

  it('gives a legacy Project with no Environments an empty config', async () => {
    const { projectId } = await createProject('empty', []);
    await ctx.db
      .delete(projectConfigLocation)
      .where(eq(projectConfigLocation.projectId, projectId));

    expect(await generateMissing()).toBe(1);

    const location = await readConfig(projectId);
    expect(parseProjectConfig(location!.text)).toEqual({
      ok: true,
      config: { version: 1, services: {} },
    });
  });
});
