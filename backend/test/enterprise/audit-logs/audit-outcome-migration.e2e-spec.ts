import { startLegacyDatabase } from '../../utils/migrations-up-to';
import type { LegacyDatabase } from '../../utils/migrations-up-to';

jest.setTimeout(180_000);

/** The last migration before an audit row carried an outcome. */
const MIGRATION_BEFORE_OUTCOME = '0073_agents';

interface Row {
  audit_log_id: string;
  outcome: string;
  user_name: string | null;
}

/**
 * Every row written before `outcome` existed was a success, because the
 * interceptor and every service writer recorded only what succeeded. So the
 * migration has to leave each of them reading `succeeded` — a null, or any
 * other default, would put a refusal or a failure in the trail that never
 * happened.
 *
 * Written against the migrator on a database whose history stops at `0073`,
 * for the reason `startLegacyDatabase` gives: the template database replays
 * every migration before any row exists, so an ordinary suite would watch the
 * default apply to nothing.
 */
describe('Audit outcome migration (e2e)', () => {
  let legacy: LegacyDatabase;

  beforeAll(async () => {
    legacy = await startLegacyDatabase('i618', MIGRATION_BEFORE_OUTCOME);
  });

  afterAll(async () => {
    await legacy?.drop();
  });

  it('reads every existing row as succeeded, with no actor name recorded', async () => {
    await legacy.pool.query(`
      insert into audit_log (audit_log_id, user_email, user_role, action, resource_type, created_at)
        values ('before-1', 'grace@example.com', 'owner', 'login', 'session', '2026-01-01T00:00:00.000Z'),
               ('before-2', 'ida@example.com', 'member', 'deploy', 'application', '2026-01-02T00:00:00.000Z');
    `);
    // The before-state, asserted: a history that already had the column would
    // make this pass against a migration that does nothing.
    const columns = await legacy.pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'audit_log' and column_name in ('outcome', 'user_name')`,
    );
    expect(columns.rows).toEqual([]);

    await legacy.migrateToHead();

    const { rows } = await legacy.pool.query<Row>(
      'select audit_log_id, outcome, user_name from audit_log order by audit_log_id',
    );
    expect(rows).toEqual([
      { audit_log_id: 'before-1', outcome: 'succeeded', user_name: null },
      { audit_log_id: 'before-2', outcome: 'succeeded', user_name: null },
    ]);
  });
});
