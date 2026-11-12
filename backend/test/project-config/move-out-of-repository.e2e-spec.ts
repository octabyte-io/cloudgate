import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  environment,
  member,
  mongo,
  plan as planTable,
  postgres,
  projectConfigLocation,
  redis,
} from '../../src/db/schema';
import { GithubService } from '../../src/git-providers/strategies/github/github.service';
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
  commitSha: string | null;
  branch: string | null;
  steps: Array<Record<string, unknown>>;
}

interface Read {
  environmentId: string;
  commitSha: string | null;
  textHash: string;
}

interface Preview {
  to: Record<string, unknown>;
  reads: Read[];
  environments: Array<{
    environmentId: string;
    name: string;
    branch: string | null;
    commitSha: string | null;
    fileUrl: string | null;
    steps: Array<Record<string, unknown>>;
  }>;
}

const connection = {
  name: 'Team GitHub',
  appName: 'cloudgate-app',
  appId: 12345,
  clientId: 'Iv1.abc123',
  clientSecret: 'github-client-secret',
  installationId: '99887766',
  privateKey:
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEfake\n-----END RSA PRIVATE KEY-----',
  webhookSecret: 'wh-secret',
};

const DATA = `version: 1
services:
  cache:
    kind: redis
    version: "7"
  db:
    kind: postgres
`;

const CACHE_ONLY = 'version: 1\nservices:\n  cache:\n    kind: redis\n';

/** A console-managed line for a Service no Environment has. */
const LEGACY = `${CACHE_ONLY}  legacy:\n    kind: mongo\n    managed: console\n`;

/** A console-managed line for `docs`, a mongo only production has. */
const DOCS_LINE = '  docs:\n    kind: mongo\n    managed: console\n';

/**
 * An operator moves a repository-kept config back into Cloudgate,
 * keeping the copy they pick (by default the default branch's), or to another
 * repository or path. Both are the move's preview and confirm, and apply
 * nothing.
 */
describe('Moving a Project config out of a repository, or between repositories (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let ownerId: string;
  let organizationId: string;
  let projectId: string;
  let productionId: string;
  let stagingId: string;
  let gitProviderId: string;

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
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
    organizationId = (orgs.body as { id: string }[])[0].id;

    const project = await request(server)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'shop' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;
    productionId = await createEnvironment('production');
    stagingId = await createEnvironment('staging');

    const github = await ctx.app.get(GithubService).create(
      {
        user: { id: ownerId },
        session: { activeOrganizationId: organizationId },
      },
      connection,
    );
    gitProviderId = github.gitProvider.gitProviderId;
  });

  async function createEnvironment(name: string) {
    const created = await request(server)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ name, projectId });
    expect(created.status).toBe(201);
    return (created.body as { environmentId: string }).environmentId;
  }

  const setConfigBranch = (environmentId: string, configBranch: string) =>
    request(server)
      .patch(`/environments/${environmentId}`)
      .set('Cookie', cookie)
      .send({ configBranch });

  const repository = (name = 'acme/shop', extra: object = {}) => ({
    kind: 'repository',
    gitProviderId,
    repository: name,
    ...extra,
  });

  const preview = (to: object, as = cookie) =>
    request(server)
      .post(`/projects/${projectId}/config/move/preview`)
      .set('Cookie', as)
      .send({ to });

  const confirm = (body: { to: object; reads: Read[] }, as = cookie) =>
    request(server)
      .post(`/projects/${projectId}/config/move`)
      .set('Cookie', as)
      .send(body);

  /** Previews and confirms a move, answering the plans it stored. */
  async function move(to: object): Promise<PlanBody[]> {
    const previewed = await preview(to);
    expect(previewed.status).toBe(200);
    const { reads } = previewed.body as Preview;
    const confirmed = await confirm({ to, reads });
    expect(confirmed.status).toBe(200);
    return (confirmed.body as { plans: PlanBody[] }).plans;
  }

  async function location() {
    const [found] = await ctx.db
      .select()
      .from(projectConfigLocation)
      .where(eq(projectConfigLocation.projectId, projectId));
    return found;
  }

  async function configBranches() {
    const rows = await ctx.db
      .select({ configBranch: environment.configBranch })
      .from(environment)
      .where(eq(environment.projectId, projectId));
    return rows.map((row) => row.configBranch);
  }

  /** The repository keeps DATA on main and CACHE_ONLY on staging, which staging reads. */
  async function keptInRepository() {
    const mainSha = ctx.configReader.commit('acme/shop', DATA);
    const stagingSha = ctx.configReader.commit('acme/shop', CACHE_ONLY, {
      branch: 'staging',
    });
    expect((await setConfigBranch(stagingId, 'staging')).status).toBe(200);
    const plans = await move(repository());
    return { mainSha, stagingSha, plans };
  }

  describe('out of a repository', () => {
    it("keeps the default branch's copy by default, clears every Config branch, dismisses the old plans, and applies nothing", async () => {
      const { mainSha, plans: old } = await keptInRepository();

      const previewed = await preview({ kind: 'cloudgate' });
      expect(previewed.status).toBe(200);
      const body = previewed.body as Preview;
      expect(body.to).toMatchObject({
        kind: 'cloudgate',
        fromEnvironmentId: null,
        copy: {
          repository: 'acme/shop',
          path: 'cloudgate.yaml',
          branch: 'main',
          commitSha: mainSha,
          text: DATA,
        },
      });
      // Each Environment's plan is of the one kept text, not of its branch.
      const staging = body.environments.find(
        (one) => one.environmentId === stagingId,
      );
      expect(staging).toMatchObject({ branch: null, commitSha: null });
      expect(staging?.steps.map((step) => step.configName)).toEqual([
        'cache',
        'db',
      ]);
      // A preview stores nothing.
      expect((await location()).kind).toBe('repository');

      const confirmed = await confirm({
        to: { kind: 'cloudgate' },
        reads: body.reads,
      });
      expect(confirmed.status).toBe(200);

      expect(await location()).toMatchObject({
        kind: 'cloudgate',
        text: DATA,
        gitProviderId: null,
        repository: null,
        path: null,
      });
      expect(await configBranches()).toEqual([null, null]);
      for (const one of old) {
        const [found] = await ctx.db
          .select()
          .from(planTable)
          .where(eq(planTable.planId, one.planId));
        expect(found).toMatchObject({
          status: 'dismissed',
          dismissedBy: ownerId,
        });
      }
      const plans = (confirmed.body as { plans: PlanBody[] }).plans;
      expect(plans).toHaveLength(2);
      for (const one of plans) {
        expect(one).toMatchObject({
          source: 'move',
          status: 'open',
          commitSha: null,
          branch: null,
        });
      }
      expect(await ctx.db.select().from(redis)).toHaveLength(0);
      expect(await ctx.db.select().from(postgres)).toHaveLength(0);

      // The config page notes the file it no longer reads.
      const config = await request(server)
        .get(`/projects/${projectId}/config`)
        .set('Cookie', cookie);
      expect(
        (config.body as { location: Record<string, unknown> }).location,
      ).toMatchObject({
        kind: 'cloudgate',
        text: DATA,
        movedOutOf: {
          repository: 'acme/shop',
          path: 'cloudgate.yaml',
          providerType: 'github',
        },
      });

      // The moved-out plan applies from the kept text.
      const production = plans.find(
        (one) => one.environmentId === productionId,
      );
      const applied = await request(server)
        .post(`/environments/${productionId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId: production?.planId });
      expect(applied.status).toBe(200);
    });

    it("keeps the chosen Environment's copy", async () => {
      const { stagingSha } = await keptInRepository();
      const to = { kind: 'cloudgate', fromEnvironmentId: stagingId };

      const previewed = await preview(to);
      expect(previewed.status).toBe(200);
      expect((previewed.body as Preview).to).toMatchObject({
        kind: 'cloudgate',
        fromEnvironmentId: stagingId,
        copy: { branch: 'staging', commitSha: stagingSha, text: CACHE_ONLY },
      });
      const confirmed = await confirm({
        to,
        reads: (previewed.body as Preview).reads,
      });
      expect(confirmed.status).toBe(200);

      expect((await location()).text).toBe(CACHE_ONLY);
      expect(await configBranches()).toEqual([null, null]);
    });

    it('is refused when the chosen copy changed since the preview', async () => {
      await keptInRepository();
      const to = { kind: 'cloudgate', fromEnvironmentId: stagingId };
      const previewed = await preview(to);
      ctx.configReader.commit(
        'acme/shop',
        `${CACHE_ONLY}  more:\n    kind: redis\n`,
        {
          branch: 'staging',
        },
      );

      const confirmed = await confirm({
        to,
        reads: (previewed.body as Preview).reads,
      });

      expect(confirmed.status).toBe(409);
      expect((confirmed.body as { code: string }).code).toBe('MOVE_STALE');
      expect((await location()).kind).toBe('repository');
      expect(await configBranches()).toContain('staging');
    });

    it('is refused when the chosen copy cannot be read or does not parse', async () => {
      await keptInRepository();
      ctx.configReader.commit('acme/shop', 'version: 1\nservices: [\n', {
        branch: 'staging',
      });
      const invalid = await preview({
        kind: 'cloudgate',
        fromEnvironmentId: stagingId,
      });
      expect(invalid.status).toBe(409);
      expect((invalid.body as { code: string }).code).toBe('PLAN_REFUSED');

      ctx.configReader.setUnreachable('acme/shop');
      const unreadable = await preview({ kind: 'cloudgate' });
      expect(unreadable.status).toBe(409);
      expect(
        unreadable.body as { code: string; message: string },
      ).toMatchObject({
        code: 'CONFIG_UNREADABLE',
        message: expect.stringContaining('acme/shop') as string,
      });
    });

    it("refuses an Environment that is not the Project's", async () => {
      await keptInRepository();

      const previewed = await preview({
        kind: 'cloudgate',
        fromEnvironmentId: 'not-an-environment',
      });

      expect(previewed.status).toBe(404);
    });

    it('refuses a config already kept in Cloudgate', async () => {
      const previewed = await preview({ kind: 'cloudgate' });

      expect(previewed.status).toBe(409);
      expect((previewed.body as { code: string }).code).toBe(
        'PROJECT_CONFIG_NOT_REPOSITORY_KEPT',
      );
    });

    it('needs project: update', async () => {
      await keptInRepository();
      const fixture = await signUpMember(server, cookie);
      await ctx.db
        .update(member)
        .set({
          accessedProjects: [projectId],
          accessedEnvironments: [productionId, stagingId],
        })
        .where(eq(member.userId, fixture.id));

      expect(
        (await preview({ kind: 'cloudgate' }, fixture.cookie)).status,
      ).toBe(403);
      expect(
        (
          await confirm(
            { to: { kind: 'cloudgate' }, reads: [] },
            fixture.cookie,
          )
        ).status,
      ).toBe(403);
    });
  });

  describe('between repositories', () => {
    it("reads every Environment's copy at the new place, plans it against the config in effect at the old one, and applies nothing", async () => {
      // `docs` exists only in production, so the config lists it as
      // console-managed, a line staging took without the Service.
      await ctx.db.insert(mongo).values({
        name: 'Docs',
        configName: 'docs',
        databaseUser: 'docs',
        databasePassword: 'secret',
        environmentId: productionId,
      });
      await ctx.db
        .update(projectConfigLocation)
        .set({ text: `version: 1\nservices:\n${DOCS_LINE}` })
        .where(eq(projectConfigLocation.projectId, projectId));
      ctx.configReader.commit('acme/shop', `${DATA}${DOCS_LINE}`);
      ctx.configReader.commit('acme/shop', `${CACHE_ONLY}${DOCS_LINE}`, {
        branch: 'staging',
      });
      expect((await setConfigBranch(stagingId, 'staging')).status).toBe(200);
      await move(repository());
      // Carrying the line to the new place, with the move's plans still
      // open, is not adding it.
      const mainSha = ctx.configReader.commit(
        'acme/deploy',
        `${CACHE_ONLY}${DOCS_LINE}`,
        { path: 'shop/cloudgate.yaml' },
      );
      const stagingSha = ctx.configReader.commit(
        'acme/deploy',
        `${CACHE_ONLY}${DOCS_LINE}`,
        { path: 'shop/cloudgate.yaml', branch: 'staging' },
      );
      const to = repository('acme/deploy', { path: 'shop/cloudgate.yaml' });

      const previewed = await preview(to);
      expect(previewed.status).toBe(200);
      const body = previewed.body as Preview;
      expect(
        body.environments.map((one) => [one.environmentId, one.commitSha]),
      ).toEqual(
        expect.arrayContaining([
          [productionId, mainSha],
          [stagingId, stagingSha],
        ]),
      );

      const confirmed = await confirm({ to, reads: body.reads });
      expect(confirmed.status).toBe(200);
      expect(await location()).toMatchObject({
        kind: 'repository',
        text: null,
        repository: 'acme/deploy',
        path: 'shop/cloudgate.yaml',
      });
      // Config branches stay: each Environment reads its branch at the new place.
      expect(await configBranches()).toContain('staging');
      const plans = (confirmed.body as { plans: PlanBody[] }).plans;
      expect(
        plans.find((one) => one.environmentId === stagingId),
      ).toMatchObject({
        source: 'move',
        branch: 'staging',
        commitSha: stagingSha,
      });
      expect(await ctx.db.select().from(redis)).toHaveLength(0);
    });

    it('is refused when any new copy is unreadable or invalid, and changes nothing', async () => {
      await keptInRepository();
      ctx.configReader.commit('acme/deploy', DATA);
      const missing = await preview(repository('acme/deploy'));
      expect(missing.status).toBe(409);
      expect(missing.body as { code: string; message: string }).toMatchObject({
        code: 'CONFIG_UNREADABLE',
        message: expect.stringMatching(/acme\/deploy.*staging/) as string,
      });

      ctx.configReader.commit(
        'acme/deploy',
        'version: 1\nservices:\n  cache:\n    kind: redis\n    colour: blue\n',
        { branch: 'staging' },
      );
      const invalid = await preview(repository('acme/deploy'));
      expect(invalid.status).toBe(409);
      expect((invalid.body as { code: string }).code).toBe('PLAN_REFUSED');
      expect((await location()).repository).toBe('acme/shop');
    });
  });

  describe('adding a console-managed line', () => {
    it('is still refused when the old copy did not have it', async () => {
      await keptInRepository();
      ctx.configReader.commit('acme/deploy', LEGACY);
      ctx.configReader.commit('acme/deploy', LEGACY, { branch: 'staging' });

      const previewed = await preview(repository('acme/deploy'));

      expect(previewed.status).toBe(409);
      expect((previewed.body as { message: string }).message).toContain(
        'legacy',
      );
    });
  });
});
