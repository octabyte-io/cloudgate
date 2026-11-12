import { startLegacyDatabase } from '../utils/migrations-up-to';
import type { LegacyDatabase } from '../utils/migrations-up-to';

jest.setTimeout(180_000);

/** The last migration before `application.config_kind` existed. */
const MIGRATION_BEFORE_CONFIG_KIND = '0115_cloud-place';

/**
 * An Application records its config kind rather than having it worked
 * out from its build type. The migration that adds the record backfills each
 * existing Application to the kind its build type gave it, so no generated
 * config and no first plan changes.
 */
describe('Application config kind backfill (e2e)', () => {
  let legacy: LegacyDatabase;

  beforeAll(async () => {
    legacy = await startLegacyDatabase('i863', MIGRATION_BEFORE_CONFIG_KIND);
  });

  afterAll(async () => {
    await legacy?.drop();
  });

  it('records static for a static build and web for every other build type', async () => {
    await legacy.pool.query(`
      insert into "user" (id, email, updated_at)
        values ('user-1', 'grace@example.com', now());
      insert into organization (id, name, created_at, owner_id)
        values ('org-1', 'Acme', now(), 'user-1');
      insert into project (project_id, name, created_at, organization_id)
        values ('p-1', 'Shop', now(), 'org-1');
      insert into environment (environment_id, name, created_at, project_id)
        values ('e-1', 'production', now(), 'p-1');
      insert into application (application_id, name, config_name, app_name, created_at, environment_id, build_type)
        values ('app-static',     'Static',     'static',     'app-static',     now(), 'e-1', 'static'),
               ('app-nixpacks',   'Nixpacks',   'nixpacks',   'app-nixpacks',   now(), 'e-1', 'nixpacks'),
               ('app-dockerfile', 'Dockerfile', 'dockerfile', 'app-dockerfile', now(), 'e-1', 'dockerfile'),
               ('app-railpack',   'Railpack',   'railpack',   'app-railpack',   now(), 'e-1', 'railpack');
    `);

    await legacy.migrateToHead();

    const { rows } = await legacy.pool.query<{
      application_id: string;
      config_kind: string;
    }>(
      'select application_id, config_kind from application order by application_id',
    );
    expect(
      Object.fromEntries(rows.map((r) => [r.application_id, r.config_kind])),
    ).toEqual({
      'app-dockerfile': 'web',
      'app-nixpacks': 'web',
      'app-railpack': 'web',
      'app-static': 'static',
    });
  });
});
