import { parse } from 'dotenv';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ApplicationsService } from '../../src/applications/applications.service';
import { application } from '../../src/db/schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Sam Rivera',
  email: 'sam@shop.example',
  password: 'super-secret-password',
};

/**
 * A Service's own runtime variables by name: set and
 * unset key by key, listed by name with the Output each wired one links to,
 * and never answered with a value (ADR 0019). Every answer is checked for
 * the values the walk typed, so a route that echoed one would fail here.
 */
describe('Application variables (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let applicationId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    const signedUp = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(signedUp.status).toBe(200);
    cookie = (signedUp.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const userId = (signedUp.body as { user: { id: string } }).user.id;
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = {
      user: { id: userId },
      session: { activeOrganizationId: organizationId },
    };
    const project = await ctx.app
      .get(ProjectsService)
      .create(ownerCtx, { name: 'shop' });
    const staging = await ctx.app.get(EnvironmentsService).create(ownerCtx, {
      name: 'staging',
      projectId: project.projectId,
    });
    const created = await ctx.app.get(ApplicationsService).create(ownerCtx, {
      name: 'Shop API',
      appName: 'shop-api',
      environmentId: staging.environmentId,
    });
    applicationId = created.applicationId;
  });

  const path = () => `/applications/${applicationId}/variables`;

  function change(body: object) {
    return request(server).patch(path()).set('Cookie', cookie).send(body);
  }

  function list() {
    return request(server).get(path()).set('Cookie', cookie);
  }

  /** The Service's own variables as the deploy reads them. */
  async function stored(): Promise<string | null> {
    const [row] = await ctx.db
      .select({ env: application.env })
      .from(application)
      .where(eq(application.applicationId, applicationId));
    return row.env;
  }

  async function storeEnv(env: string) {
    await ctx.db
      .update(application)
      .set({ env })
      .where(eq(application.applicationId, applicationId));
  }

  it('sets named keys beside the ones already there, answering names and never a value', async () => {
    await storeEnv('# kept by hand\nLOG_LEVEL=debug\n');

    const set = await change({
      set: { STRIPE_KEY: 'sk_live_s3cr3t', MULTI: 'line one\nline "two"' },
    });

    expect(set.status).toBe(200);
    expect(set.text).not.toContain('sk_live_s3cr3t');
    expect(set.text).not.toContain('debug');
    expect(set.text).not.toContain('line one');
    expect(set.body).toEqual({
      variables: [
        { name: 'LOG_LEVEL', linkedTo: null },
        { name: 'MULTI', linkedTo: null },
        { name: 'STRIPE_KEY', linkedTo: null },
      ],
    });
    const listed = await list();
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual(set.body);
    expect(listed.text).not.toContain('sk_live_s3cr3t');

    const text = await stored();
    expect(text).toContain('# kept by hand\nLOG_LEVEL=debug');
    expect(parse(text ?? '')).toEqual({
      LOG_LEVEL: 'debug',
      STRIPE_KEY: 'sk_live_s3cr3t',
      MULTI: 'line one\nline "two"',
    });
  });

  it('replaces a key it sets again and removes a key it unsets, leaving the rest', async () => {
    await storeEnv('A=1\nB=2\nC=3\n');

    const changed = await change({ set: { A: 'one' }, unset: ['B'] });

    expect(changed.status).toBe(200);
    expect(changed.text).not.toContain('one');
    expect(changed.body).toEqual({
      variables: [
        { name: 'A', linkedTo: null },
        { name: 'C', linkedTo: null },
      ],
    });
    expect(parse((await stored()) ?? '')).toEqual({ A: 'one', C: '3' });
  });

  it('lists a wired name with the Output it links to, and refuses a typed value for it naming that Output', async () => {
    await storeEnv('LOG_LEVEL=info\n');
    await ctx.db
      .update(application)
      .set({ configLinks: { DATABASE_URL: { source: 'db', output: 'url' } } })
      .where(eq(application.applicationId, applicationId));

    expect((await list()).body).toEqual({
      variables: [
        { name: 'DATABASE_URL', linkedTo: { source: 'db', output: 'url' } },
        { name: 'LOG_LEVEL', linkedTo: null },
      ],
    });

    const refused = await change({
      set: { DATABASE_URL: 'postgres://typed', LOG_LEVEL: 'debug' },
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'VARIABLE_IS_LINKED' });
    expect((refused.body as { message: string }).message).toContain(
      'DATABASE_URL is linked to db.url',
    );
    expect(refused.text).not.toContain('postgres://typed');
    expect(await stored()).toBe('LOG_LEVEL=info\n');

    const unsetLinked = await change({ unset: ['DATABASE_URL'] });
    expect(unsetLinked.status).toBe(409);
    expect(unsetLinked.body).toMatchObject({ code: 'VARIABLE_IS_LINKED' });
    expect((unsetLinked.body as { message: string }).message).toContain(
      'db.url',
    );
  });

  it('refuses to unset a name the Service does not have, changing nothing', async () => {
    await storeEnv('A=1\n');

    const refused = await change({ unset: ['A', 'MISSING'] });

    expect(refused.status).toBe(404);
    expect(refused.body).toMatchObject({ code: 'VARIABLE_NOT_SET' });
    expect((refused.body as { message: string }).message).toContain('MISSING');
    expect(await stored()).toBe('A=1\n');
  });

  it('refuses a body that names nothing, or a name dotenv cannot read', async () => {
    expect((await change({})).status).toBe(400);
    expect((await change({ set: { 'BAD NAME': 'x' } })).status).toBe(400);
    expect((await change({ set: { A: '1' }, unset: ['A'] })).status).toBe(400);
  });

  it('two sets of different keys at once both land', async () => {
    await storeEnv('KEEP=yes\n');

    const keys = Array.from({ length: 8 }, (_, index) => `K${index}`);
    const answers = await Promise.all(
      keys.map((key) => change({ set: { [key]: `value-${key}` } })),
    );

    expect(answers.map((answer) => answer.status)).toEqual(keys.map(() => 200));
    expect(parse((await stored()) ?? '')).toEqual({
      KEEP: 'yes',
      ...Object.fromEntries(keys.map((key) => [key, `value-${key}`])),
    });
  });

  it('answers 404 for an Application in no Organization of the caller', async () => {
    const other = await request(server)
      .get('/applications/no-such-application/variables')
      .set('Cookie', cookie);
    expect(other.status).toBe(404);
  });
});
