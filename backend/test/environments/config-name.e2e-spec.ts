import request from 'supertest';
import { App } from 'supertest/types';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/**
 * Every Service is given a Config name at create, through one minting
 * path that is unique within the Environment across all kinds, and the name
 * stays put when the display name is renamed. The upgrade's backfill for
 * existing Services is `config-name-backfill.e2e-spec.ts`.
 */
describe('Service Config name (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let environmentId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
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
    environmentId = await newEnvironment('production');
  });

  async function newEnvironment(name: string): Promise<string> {
    const project = await request(server)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: `shop-${name}` });
    expect(project.status).toBe(201);
    const environment = await request(server)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        name,
        projectId: (project.body as { projectId: string }).projectId,
      });
    expect(environment.status).toBe(201);
    return (environment.body as { environmentId: string }).environmentId;
  }

  const KINDS = {
    application: { route: 'applications', id: 'applicationId', extra: {} },
    compose: { route: 'compose', id: 'composeId', extra: {} },
    postgres: {
      route: 'postgres',
      id: 'postgresId',
      extra: { databaseName: 'shop', databaseUser: 'shop' },
    },
    redis: { route: 'redis', id: 'redisId', extra: {} },
  } as const;

  async function create(
    kind: keyof typeof KINDS,
    name: string,
    inEnvironment = environmentId,
  ): Promise<{ id: string; configName: string }> {
    const { route, id, extra } = KINDS[kind];
    const res = await request(server)
      .post(`/${route}`)
      .set('Cookie', cookie)
      .send({ name, environmentId: inEnvironment, ...extra });
    expect(res.status).toBe(201);
    const body = res.body as Record<string, string>;
    return { id: body[id], configName: body.configName };
  }

  async function read(kind: keyof typeof KINDS, id: string) {
    const res = await request(server)
      .get(`/${KINDS[kind].route}/${id}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body as { name: string; configName: string };
  }

  it('gives Services of different kinds with one display name distinct Config names', async () => {
    const app = await create('application', 'Shop');
    const db = await create('postgres', 'Shop');
    const stack = await create('compose', 'Shop');
    const cache = await create('redis', 'Shop');

    expect([
      app.configName,
      db.configName,
      stack.configName,
      cache.configName,
    ]).toEqual(['shop', 'shop-2', 'shop-3', 'shop-4']);

    // Another Environment's `Shop` is its own name.
    const elsewhere = await create(
      'application',
      'Shop',
      await newEnvironment('staging'),
    );
    expect(elsewhere.configName).toBe('shop');
  });

  it('gives two Services created at once with one display name distinct Config names', async () => {
    const created = await Promise.all([
      create('application', 'Web'),
      create('postgres', 'Web'),
      create('redis', 'Web'),
    ]);
    expect(created.map((s) => s.configName).sort()).toEqual([
      'web',
      'web-2',
      'web-3',
    ]);
  });

  it('gives a display name that slugs to nothing a valid Config name', async () => {
    const db = await create('postgres', '???');
    expect(db.configName).toBe('postgres');
  });

  it('returns the Config name on each Service read and in the Environment read', async () => {
    const app = await create('application', 'Shop API');
    const db = await create('postgres', 'Orders DB');
    const stack = await create('compose', 'Edge');

    expect((await read('application', app.id)).configName).toBe('shop-api');
    expect((await read('postgres', db.id)).configName).toBe('orders-db');
    expect((await read('compose', stack.id)).configName).toBe('edge');

    const environment = await request(server)
      .get(`/environments/${environmentId}`)
      .set('Cookie', cookie);
    expect(environment.status).toBe(200);
    const services = (
      environment.body as {
        services: { serviceId: string; configName: string }[];
      }
    ).services;
    expect(
      Object.fromEntries(services.map((s) => [s.serviceId, s.configName])),
    ).toEqual({
      [app.id]: 'shop-api',
      [db.id]: 'orders-db',
      [stack.id]: 'edge',
    });
  });

  it('keeps the Config name when the display name is renamed, and ignores one in the update body', async () => {
    const app = await create('application', 'Shop');
    const db = await create('postgres', 'Orders');

    for (const [kind, id] of [
      ['application', app.id],
      ['postgres', db.id],
    ] as const) {
      const renamed = await request(server)
        .patch(`/${KINDS[kind].route}/${id}`)
        .set('Cookie', cookie)
        .send({ name: 'Storefront', configName: 'hijacked' });
      expect(renamed.status).toBe(200);
    }

    expect(await read('application', app.id)).toMatchObject({
      name: 'Storefront',
      configName: 'shop',
    });
    expect(await read('postgres', db.id)).toMatchObject({
      name: 'Storefront',
      configName: 'orders',
    });

    // The freed display name mints from scratch; the kept names still count.
    const next = await create('redis', 'Shop');
    expect(next.configName).toBe('shop-2');
  });
});
