import { startLegacyDatabase } from '../utils/migrations-up-to';
import type { LegacyDatabase } from '../utils/migrations-up-to';

jest.setTimeout(180_000);

/** The last migration before a Database's and a Bucket's `deployed_at`. */
const MIGRATION_BEFORE_DEPLOYED_AT = '0233_volume-backup-scope';

/**
 * ADR-0093, #181: a Restore of a Bought Server redeploys each Database and
 * Bucket whose `deployed_at` is newer than the backup. A row deployed before
 * the column existed has no record of when, so it reads the migration's own
 * time: newer than any backup taken before it, so a Restore errs toward a
 * redeploy, which is harmless, rather than leaving older code running under
 * a record of newer. Its `created_at` would say the opposite for any row made
 * before the backup and deployed again after it.
 */
describe('deployed_at back-fill (e2e)', () => {
  let legacy: LegacyDatabase;

  beforeAll(async () => {
    legacy = await startLegacyDatabase(
      'deployed_at',
      MIGRATION_BEFORE_DEPLOYED_AT,
    );
  });

  afterAll(async () => {
    await legacy?.drop();
  });

  it('stores the migration time on a row that was deployed, and nothing on one never deployed', async () => {
    const longAgo = '2025-01-01T00:00:00.000Z';
    await legacy.pool.query(
      `
      insert into "user" (id, email, updated_at)
        values ('user-1', 'grace@example.com', now());
      insert into organization (id, name, created_at, owner_id)
        values ('org-1', 'Acme', now(), 'user-1');
      insert into project (project_id, name, created_at, organization_id)
        values ('p-1', 'Shop', now(), 'org-1');
      insert into environment (environment_id, name, created_at, project_id)
        values ('e-1', 'production', now(), 'p-1');
      insert into postgres (postgres_id, name, config_name, app_name, database_name, database_user, database_password, application_status, created_at, environment_id)
        values ('pg-deployed', 'Orders', 'orders', 'orders', 'orders', 'shop', 'x', 'done', '${longAgo}', 'e-1'),
               ('pg-never',    'Legacy', 'legacy', 'legacy', 'legacy', 'shop', 'x', 'idle', '${longAgo}', 'e-1');
      insert into bucket (bucket_id, name, config_name, app_name, bucket_name, admin_credential, volume_name, application_status, created_at, environment_id)
        values ('b-deployed', 'Files', 'files', 'bucket-files', 'files', 'x', 'bucket-files-data', 'done', '${longAgo}', 'e-1');
    `,
    );
    const before = new Date();

    await legacy.migrateToHead();

    const after = new Date();
    const { rows } = await legacy.pool.query<{
      id: string;
      deployed_at: string | null;
    }>(`
      select postgres_id as id, deployed_at from postgres
      union all select bucket_id, deployed_at from bucket
    `);
    const at = Object.fromEntries(rows.map((r) => [r.id, r.deployed_at]));
    expect(at['pg-never']).toBeNull();
    for (const id of ['pg-deployed', 'b-deployed']) {
      // ISO in UTC, as every `isoTimestamp` column is written.
      expect(at[id]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      const stored = Date.parse(at[id]!);
      // Not its created_at: the migration ran now.
      expect(stored).toBeGreaterThanOrEqual(before.getTime() - 1_000);
      expect(stored).toBeLessThanOrEqual(after.getTime() + 1_000);
    }
  });
});
