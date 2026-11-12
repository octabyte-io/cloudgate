import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { DATABASE_ORDER_MESSAGE } from '../../src/native/docker-locks';
import {
  libsql,
  mariadb,
  mongo,
  mysql,
  postgres,
  redis,
} from '../../src/db/schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/**
 * A managed database updates and rolls back stop-first, so the API
 * refuses `start-first` in either block for every engine. The rule is one
 * schema the six DTOs share; this holds each engine's PATCH to it, since a
 * seventh DTO or a copy that drifts would otherwise store an order the deploy
 * then overrides without saying so.
 */
describe('A database’s update and rollback order (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;
  let environmentId: string;

  /** Each engine: its route, what creating one takes, and its table. */
  const engines = [
    [
      'postgres',
      { databaseName: 'shop', databaseUser: 'shop_user' },
      postgres,
      postgres.postgresId,
    ],
    [
      'mysql',
      { databaseName: 'shop', databaseUser: 'shop_user' },
      mysql,
      mysql.mysqlId,
    ],
    [
      'mariadb',
      { databaseName: 'shop', databaseUser: 'shop_user' },
      mariadb,
      mariadb.mariadbId,
    ],
    ['mongo', { databaseUser: 'mongo_user' }, mongo, mongo.mongoId],
    ['redis', {}, redis, redis.redisId],
    ['libsql', { databaseUser: 'libsql_user' }, libsql, libsql.libsqlId],
  ] as const;

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
    const userId = (res.body as { user: { id: string } }).user.id;
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
      .create(ownerCtx, { name: 'cloudgate' });
    const environment = await ctx.app
      .get(EnvironmentsService)
      .create(ownerCtx, { name: 'production', projectId: project.projectId });
    environmentId = environment.environmentId;
  });

  async function create(kind: string, fields: object): Promise<string> {
    const created = await request(server)
      .post(`/${kind}`)
      .set('Cookie', cookie)
      .send({
        name: 'Main DB',
        appName: 'main-db',
        databasePassword: 'sup3rS3cret',
        environmentId,
        ...fields,
      });
    expect(created.status).toBe(201);
    return (created.body as Record<string, string>)[`${kind}Id`];
  }

  describe.each(engines)('%s', (kind, fields, table, idColumn) => {
    it.each(['updateConfigSwarm', 'rollbackConfigSwarm'])(
      'refuses start-first in %s and stores nothing',
      async (column) => {
        const id = await create(kind, fields);

        const res = await request(server)
          .patch(`/${kind}/${id}`)
          .set('Cookie', cookie)
          .send({ [column]: { Parallelism: 1, Order: 'start-first' } });

        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).toContain(DATABASE_ORDER_MESSAGE);
        const [row] = await ctx.db.select().from(table).where(eq(idColumn, id));
        expect(row[column as keyof typeof row]).toBeNull();
      },
    );

    it('takes stop-first in both', async () => {
      const id = await create(kind, fields);
      const stopFirst = { Parallelism: 1, Order: 'stop-first' };

      const res = await request(server)
        .patch(`/${kind}/${id}`)
        .set('Cookie', cookie)
        .send({ updateConfigSwarm: stopFirst, rollbackConfigSwarm: stopFirst });

      expect(res.status).toBe(200);
    });
  });
});
