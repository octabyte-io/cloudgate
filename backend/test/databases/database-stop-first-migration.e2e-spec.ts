import { startLegacyDatabase } from '../utils/migrations-up-to';
import type { LegacyDatabase } from '../utils/migrations-up-to';

jest.setTimeout(180_000);

/** The last migration before the one that rewrites a stored start-first. */
const MIGRATION_BEFORE_FIX = '0166_ai-model-llama-cpp';

/**
 * A database's deploy forces stop-first over its stored update and
 * rollback, so `0167` rewrites a stored `start-first` to it, and what the
 * console reads back is what runs. The six tables share one statement shape;
 * a typo in any of them fails `migrateToHead` itself, so one table's rows
 * prove the rewrite.
 */
describe('Database stop-first migration (e2e)', () => {
  let legacy: LegacyDatabase;

  beforeAll(async () => {
    legacy = await startLegacyDatabase('i0167', MIGRATION_BEFORE_FIX);
  });

  afterAll(async () => {
    await legacy?.drop();
  });

  it('rewrites a stored start-first and leaves every other field alone', async () => {
    const startFirst = JSON.stringify({
      Parallelism: 2,
      Order: 'start-first',
      FailureAction: 'pause',
    });
    const stopFirst = JSON.stringify({ Parallelism: 3, Order: 'stop-first' });
    await legacy.pool.query(
      `
      insert into "user" (id, email, updated_at)
        values ('user-1', 'grace@example.com', now());
      insert into organization (id, name, created_at, owner_id)
        values ('org-1', 'Acme', now(), 'user-1');
      insert into project (project_id, name, created_at, organization_id)
        values ('project-1', 'cloudgate', '2026-01-01T00:00:00.000Z', 'org-1');
      insert into environment (environment_id, name, created_at, project_id)
        values ('env-1', 'production', '2026-01-01T00:00:00.000Z', 'project-1');
      insert into mariadb (
        mariadb_id, name, config_name, app_name, database_name, database_user,
        database_password, database_root_password, docker_image,
        created_at, environment_id, update_config_swarm, rollback_config_swarm
      ) values
        ('both', 'Both', 'both', 'both-db', 'shop', 'shop_user', 'x', 'y',
         'mariadb:11', '2026-01-01T00:00:00.000Z', 'env-1',
         '${startFirst}', '${startFirst}'),
        ('kept', 'Kept', 'kept', 'kept-db', 'shop', 'shop_user', 'x', 'y',
         'mariadb:11', '2026-01-01T00:00:00.000Z', 'env-1',
         '${stopFirst}', null);
    `,
    );

    await legacy.migrateToHead();

    const rows = await legacy.pool.query<{
      mariadb_id: string;
      update: unknown;
      rollback: unknown;
    }>(
      `select mariadb_id, update_config_swarm as "update",
         rollback_config_swarm as "rollback"
       from mariadb order by mariadb_id`,
    );
    const rewritten = {
      Parallelism: 2,
      Order: 'stop-first',
      FailureAction: 'pause',
    };
    expect(rows.rows).toEqual([
      { mariadb_id: 'both', update: rewritten, rollback: rewritten },
      {
        mariadb_id: 'kept',
        update: { Parallelism: 3, Order: 'stop-first' },
        rollback: null,
      },
    ]);
  });
});
