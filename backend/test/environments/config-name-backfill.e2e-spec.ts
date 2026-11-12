import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MIGRATIONS_FOLDER,
  startLegacyDatabase,
} from '../utils/migrations-up-to';
import type { LegacyDatabase } from '../utils/migrations-up-to';

jest.setTimeout(180_000);

/** The last migration before every Service carried a Config name. */
const MIGRATION_BEFORE_CONFIG_NAME = '0094_trace-store';

/**
 * `0095_service-config-name.sql` gives every existing Service a Config
 * name minted from its display name, oldest Service in the Environment first
 * and across all eight kinds, before the column becomes non-null and unique
 * per Environment.
 *
 * Written against the migrator on a database whose history stops at `0094`,
 * for the reason `startLegacyDatabase` gives.
 */
describe('Service Config name backfill (e2e)', () => {
  let legacy: LegacyDatabase;

  beforeAll(async () => {
    legacy = await startLegacyDatabase('i747', MIGRATION_BEFORE_CONFIG_NAME);
  });

  afterAll(async () => {
    await legacy?.drop();
  });

  const SERVICE_TABLES = [
    ['application', 'application_id'],
    ['compose', 'compose_id'],
    ['postgres', 'postgres_id'],
    ['mysql', 'mysql_id'],
    ['mariadb', 'mariadb_id'],
    ['mongo', 'mongo_id'],
    ['redis', 'redis_id'],
    ['libsql', 'libsql_id'],
  ] as const;

  const configNames = async (): Promise<Record<string, string>> => {
    const rows = await legacy.pool.query<{ id: string; config_name: string }>(
      SERVICE_TABLES.map(
        ([table, id]) => `select ${id} as id, config_name from ${table}`,
      ).join(' union all '),
    );
    return Object.fromEntries(rows.rows.map((r) => [r.id, r.config_name]));
  };

  it('mints a name for every existing Service from its display name, oldest first, -2 on a clash across kinds', async () => {
    const at = (day: number) =>
      `'2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z'`;
    await legacy.pool.query(`
      insert into "user" (id, email, updated_at)
        values ('user-1', 'grace@example.com', now());
      insert into organization (id, name, created_at, owner_id)
        values ('org-1', 'Acme', now(), 'user-1');
      insert into project (project_id, name, created_at, organization_id)
        values ('p-1', 'Shop', now(), 'org-1');
      insert into environment (environment_id, name, created_at, project_id)
        values ('e-1', 'production', now(), 'p-1'),
               ('e-2', 'staging',    now(), 'p-1');

      -- 'Shop' three times in e-1, across three kinds: the oldest keeps
      -- 'shop', whichever table it is in. 'shop-2' is the postgres, made
      -- second, even though its table is read after redis's.
      insert into redis (redis_id, name, app_name, database_password, created_at, environment_id)
        values ('redis-shop', 'Shop', 'redis-shop', 'x', ${at(1)}, 'e-1');
      insert into application (application_id, name, app_name, created_at, environment_id)
        values ('app-shop',  'Shop',      'app-shop',  ${at(3)}, 'e-1'),
               ('app-api',   'Shop API!', 'app-api',   ${at(4)}, 'e-1'),
               ('app-digit', '2048 Game', 'app-digit', ${at(5)}, 'e-1'),
               ('app-blank', '???',       'app-blank', ${at(6)}, 'e-1');
      insert into postgres (postgres_id, name, app_name, database_name, database_user, database_password, created_at, environment_id)
        values ('pg-shop', 'shop', 'pg-shop', 'shop', 'shop', 'x', ${at(2)}, 'e-1'),
               ('pg-blank', '日本', 'pg-blank', 'jp', 'jp', 'x', ${at(7)}, 'e-1'),
               ('pg-blank-2', '', 'pg-blank-2', 'jp', 'jp', 'x', ${at(8)}, 'e-1');
      insert into compose (compose_id, name, app_name, created_at, environment_id)
        values ('stack-shop', 'Shop', 'stack-shop', ${at(9)}, 'e-1');
      insert into mysql (mysql_id, name, app_name, database_name, database_user, database_password, database_root_password, created_at, environment_id)
        values ('my-1', 'Orders', 'my-1', 'o', 'o', 'x', 'x', ${at(1)}, 'e-1');
      insert into mariadb (mariadb_id, name, app_name, database_name, database_user, database_password, database_root_password, created_at, environment_id)
        values ('maria-1', 'Orders', 'maria-1', 'o', 'o', 'x', 'x', ${at(2)}, 'e-1');
      insert into mongo (mongo_id, name, app_name, database_user, database_password, created_at, environment_id)
        values ('mongo-1', 'Events', 'mongo-1', 'e', 'x', ${at(1)}, 'e-1');
      insert into libsql (libsql_id, name, app_name, database_user, database_password, created_at, environment_id)
        values ('sqld-1', 'Edge Cache', 'sqld-1', 'e', 'x', ${at(1)}, 'e-1');

      -- Another Environment's 'Shop' is its own name.
      insert into application (application_id, name, app_name, created_at, environment_id)
        values ('app-staging', 'Shop', 'app-staging', ${at(10)}, 'e-2');
    `);

    await legacy.migrateToHead();

    expect(await configNames()).toEqual({
      'redis-shop': 'shop',
      'pg-shop': 'shop-2',
      'app-shop': 'shop-3',
      'stack-shop': 'shop-4',
      'app-api': 'shop-api',
      'app-digit': 'application-2048-game',
      'app-blank': 'application',
      'pg-blank': 'postgres',
      'pg-blank-2': 'postgres-2',
      'my-1': 'orders',
      'maria-1': 'orders-2',
      'mongo-1': 'events',
      'sqld-1': 'edge-cache',
      'app-staging': 'shop',
    });
  });

  it('is idempotent: running the backfill again changes nothing', async () => {
    const before = await configNames();
    const migration = readFileSync(
      join(MIGRATIONS_FOLDER, '0095_service-config-name.sql'),
      'utf8',
    );
    const backfill = migration
      .split('--> statement-breakpoint')
      .find((statement) => statement.includes('mint_config_names'));
    expect(backfill).toBeDefined();
    await legacy.pool.query(backfill!);
    expect(await configNames()).toEqual(before);
  });

  it('refuses a second Service with the same Config name in one Environment, and a malformed one', async () => {
    await expect(
      legacy.pool.query(
        `insert into application (application_id, name, app_name, config_name, created_at, environment_id)
           values ('app-dup', 'Again', 'app-dup', 'shop-3', now(), 'e-1')`,
      ),
    ).rejects.toThrow(/application_environment_config_name_unique/);
    await expect(
      legacy.pool.query(
        `insert into application (application_id, name, app_name, config_name, created_at, environment_id)
           values ('app-bad', 'Bad', 'app-bad', 'Not-Valid', now(), 'e-1')`,
      ),
    ).rejects.toThrow(/application_config_name_format/);
    await expect(
      legacy.pool.query(
        `insert into application (application_id, name, app_name, created_at, environment_id)
           values ('app-none', 'None', 'app-none', now(), 'e-1')`,
      ),
    ).rejects.toThrow(/null value in column "config_name"/);
  });
});
