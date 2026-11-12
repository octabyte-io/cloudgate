import { startLegacyDatabase } from '../utils/migrations-up-to';
import type { LegacyDatabase } from '../utils/migrations-up-to';

jest.setTimeout(180_000);

/** The last migration before the one that fixes MariaDB's default image. */
const MIGRATION_BEFORE_FIX = '0052_environment-description';

/**
 * `0053`, the tree's first data migration, and the spec the technique every
 * migration proof uses was written in.
 *
 * **It started a Postgres container of its own until the fix.** What a migration
 * proof needs is a per-database *history*, which the shared server gives it
 * for free: `startLegacyDatabase` creates a database on the server the run
 * already holds the machine-wide lock for, replays `drizzle/` up to the
 * cutoff, and drops it afterwards. A second container cost the run about a
 * gigabyte and bought nothing — see that helper's docblock for the argument
 * and for the two specs that had already reached that conclusion.
 */
describe('MariaDB default image migration (e2e)', () => {
  let legacy: LegacyDatabase;

  beforeAll(async () => {
    // The schema as it stood before the fix, so rows can be written the way
    // an already-running deployment holds them.
    legacy = await startLegacyDatabase('i0053', MIGRATION_BEFORE_FIX);
  });

  afterAll(async () => {
    await legacy?.drop();
  });

  it('corrects databases left on the unpullable mariadb:6', async () => {
    await legacy.pool.query(`
      insert into "user" (id, email, updated_at)
        values ('user-1', 'grace@example.com', now());
      insert into organization (id, name, created_at, owner_id)
        values ('org-1', 'Acme', now(), 'user-1');
      insert into project (project_id, name, created_at, organization_id)
        values ('project-1', 'cloudgate', '2026-01-01T00:00:00.000Z', 'org-1');
      insert into environment (environment_id, name, created_at, project_id)
        values ('env-1', 'production', '2026-01-01T00:00:00.000Z', 'project-1');
      insert into mariadb (
        mariadb_id, name, app_name, database_name, database_user,
        database_password, database_root_password, docker_image,
        created_at, environment_id
      ) values
        ('stuck', 'Stuck DB', 'stuck-db', 'shop', 'shop_user', 'x', 'y',
         'mariadb:6', '2026-01-01T00:00:00.000Z', 'env-1'),
        ('pinned', 'Pinned DB', 'pinned-db', 'shop', 'shop_user', 'x', 'y',
         'mariadb:10.11', '2026-01-01T00:00:00.000Z', 'env-1');
    `);

    await legacy.migrateToHead();

    const images = await legacy.pool.query<{
      mariadb_id: string;
      image: string;
    }>(
      'select mariadb_id, docker_image as image from mariadb order by mariadb_id',
    );
    expect(images.rows).toEqual([
      // A database on its own published tag is left exactly as its owner set it.
      { mariadb_id: 'pinned', image: 'mariadb:10.11' },
      { mariadb_id: 'stuck', image: 'mariadb:11' },
    ]);
  });
});
