import { startLegacyDatabase } from '../utils/migrations-up-to';
import type { LegacyDatabase } from '../utils/migrations-up-to';

jest.setTimeout(180_000);

/** The last migration before `compose.compose_path` lost its default. */
const MIGRATION_BEFORE_NO_DEFAULT = '0230_compose-path-nullable';

/**
 * ADR-0091: a new Compose Service names no file, so `compose_path` has no
 * default. Existing Services keep their saved path: the migration drops the
 * default and changes no row.
 */
describe('Compose path with no default (e2e)', () => {
  let legacy: LegacyDatabase;

  beforeAll(async () => {
    legacy = await startLegacyDatabase('adr0091', MIGRATION_BEFORE_NO_DEFAULT);
  });

  afterAll(async () => {
    await legacy?.drop();
  });

  it('keeps every saved path and stores none for a row made after it', async () => {
    await legacy.pool.query(`
      insert into "user" (id, email, updated_at)
        values ('user-1', 'grace@example.com', now());
      insert into organization (id, name, created_at, owner_id)
        values ('org-1', 'Acme', now(), 'user-1');
      insert into project (project_id, name, created_at, organization_id)
        values ('p-1', 'Shop', now(), 'org-1');
      insert into environment (environment_id, name, created_at, project_id)
        values ('e-1', 'production', now(), 'p-1');
      insert into compose (compose_id, name, config_name, app_name, created_at, environment_id)
        values ('c-defaulted', 'Defaulted', 'defaulted', 'c-defaulted', now(), 'e-1');
      insert into compose (compose_id, name, config_name, app_name, created_at, environment_id, compose_path)
        values ('c-named',   'Named',   'named',   'c-named',   now(), 'e-1', './deploy/stack.yml'),
               ('c-cleared', 'Cleared', 'cleared', 'c-cleared', now(), 'e-1', null);
    `);

    await legacy.migrateToHead();

    await legacy.pool.query(`
      insert into compose (compose_id, name, config_name, app_name, created_at, environment_id)
        values ('c-new', 'New', 'new', 'c-new', now(), 'e-1');
    `);
    const { rows } = await legacy.pool.query<{
      compose_id: string;
      compose_path: string | null;
    }>('select compose_id, compose_path from compose order by compose_id');
    expect(
      Object.fromEntries(rows.map((r) => [r.compose_id, r.compose_path])),
    ).toEqual({
      'c-cleared': null,
      'c-defaulted': './docker-compose.yml',
      'c-named': './deploy/stack.yml',
      'c-new': null,
    });
  });
});
