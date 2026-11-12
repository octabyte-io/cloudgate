import { startLegacyDatabase } from '../utils/migrations-up-to';
import type { LegacyDatabase } from '../utils/migrations-up-to';

jest.setTimeout(180_000);

/** The last migration before a preview had a trigger. */
const MIGRATION_BEFORE_REQUESTED_PREVIEWS = '0077_deployment-preview-link';

/**
 * Every preview written before the trigger existed was the webhook's,
 * and every Application predates the switch. So the migration has to leave the
 * one reading `pullRequest` with no expiry, and the other reading requested
 * previews **not** allowed — a backfilled `true` would widen what a
 * `deployment: ['create']` grant reaches on every existing Application.
 *
 * Against the migrator on a database whose history stops at `0077`, for the
 * reason `startLegacyDatabase` gives: the template replays every migration
 * before any row exists.
 */
describe('Requested previews migration (e2e)', () => {
  let legacy: LegacyDatabase;

  beforeAll(async () => {
    legacy = await startLegacyDatabase(
      'i650',
      MIGRATION_BEFORE_REQUESTED_PREVIEWS,
    );
    await legacy.pool.query(`
      insert into "user" (id, email, updated_at)
        values ('user-1', 'grace@example.com', now());
      insert into organization (id, name, created_at, owner_id)
        values ('org-1', 'Acme', now(), 'user-1');
      insert into project (project_id, name, created_at, organization_id)
        values ('project-1', 'cloudgate', '2026-01-01T00:00:00.000Z', 'org-1');
      insert into environment (environment_id, name, created_at, project_id)
        values ('env-1', 'production', '2026-01-01T00:00:00.000Z', 'project-1');
      insert into application (
        application_id, name, app_name, created_at, environment_id, is_preview_deployments_active
      ) values ('app-1', 'Shop API', 'shop-api', '2026-01-01T00:00:00.000Z', 'env-1', true);
      insert into preview_deployment (
        preview_deployment_id, branch, pull_request_id, pull_request_number,
        pull_request_title, pull_request_url, app_name, domain, created_at, application_id
      ) values (
        'preview-1', 'feature/health', '990001', '42', 'Add health endpoint',
        'https://github.com/example-org/shop/pull/42', 'preview-shop-api-abc123',
        'preview-shop-api-abc123.preview.example.com', '2026-01-01T00:00:00.000Z', 'app-1'
      );
      insert into web_server_settings (id, created_at, updated_at)
        values ('settings-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    // The before-state, asserted: a history that already had the columns would
    // make every assertion below pass against a migration that does nothing.
    const columns = await legacy.pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name in ('preview_deployment', 'application', 'web_server_settings')
          and column_name in ('trigger', 'expires_at', 'requester_id',
          'requested_previews_allowed', 'requested_preview_max_ttl_minutes')`,
    );
    expect(columns.rows).toEqual([]);

    await legacy.migrateToHead();
  });

  afterAll(async () => {
    await legacy?.drop();
  });

  it('reads an Application from before the switch as not allowing requested previews', async () => {
    const { rows } = await legacy.pool.query<{
      requested_previews_allowed: boolean;
    }>(
      `select requested_previews_allowed from application where application_id = 'app-1'`,
    );
    expect(rows).toEqual([{ requested_previews_allowed: false }]);
  });

  it("reads a preview from before the trigger as a pull request's, with no requester and no expiry", async () => {
    const { rows } = await legacy.pool.query(
      `select trigger, requester_id, expires_at, pull_request_number
         from preview_deployment where preview_deployment_id = 'preview-1'`,
    );
    expect(rows).toEqual([
      {
        trigger: 'pullRequest',
        requester_id: null,
        expires_at: null,
        pull_request_number: '42',
      },
    ]);
  });

  it('gives the existing settings row a maximum TTL of 24 hours', async () => {
    const { rows } = await legacy.pool.query<{
      requested_preview_max_ttl_minutes: number;
    }>('select requested_preview_max_ttl_minutes from web_server_settings');
    expect(rows).toEqual([{ requested_preview_max_ttl_minutes: 1440 }]);
  });
});
