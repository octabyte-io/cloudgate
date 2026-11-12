import { startLegacyDatabase } from '../utils/migrations-up-to';
import type { LegacyDatabase } from '../utils/migrations-up-to';

jest.setTimeout(180_000);

/** A migration from before `application.port` existed. */
const MIGRATION_BEFORE_PORT = '0095_service-config-name';

/**
 * `application.port` is the config-owned `web.port`. The migration that
 * adds it backfills it from the Application's Domains when they all agree on
 * one, so a generated config's `port` says what the Application already
 * serves on; otherwise it is 3000.
 */
describe('Application port backfill (e2e)', () => {
  let legacy: LegacyDatabase;

  beforeAll(async () => {
    legacy = await startLegacyDatabase('i750', MIGRATION_BEFORE_PORT);
  });

  afterAll(async () => {
    await legacy?.drop();
  });

  it('takes the port every Domain of the Application agrees on, else 3000', async () => {
    await legacy.pool.query(`
      insert into "user" (id, email, updated_at)
        values ('user-1', 'grace@example.com', now());
      insert into organization (id, name, created_at, owner_id)
        values ('org-1', 'Acme', now(), 'user-1');
      insert into project (project_id, name, created_at, organization_id)
        values ('p-1', 'Shop', now(), 'org-1');
      insert into environment (environment_id, name, created_at, project_id)
        values ('e-1', 'production', now(), 'p-1');
      insert into application (application_id, name, config_name, app_name, created_at, environment_id)
        values ('app-agree',    'Agree',    'agree',    'app-agree',    now(), 'e-1'),
               ('app-disagree', 'Disagree', 'disagree', 'app-disagree', now(), 'e-1'),
               ('app-default',  'Default',  'default',  'app-default',  now(), 'e-1'),
               ('app-none',     'None',     'none',     'app-none',     now(), 'e-1');
      insert into domain (domain_id, host, port, application_id, created_at)
        values ('d-1', 'a.example.com', 8080, 'app-agree',    now()),
               ('d-2', 'b.example.com', 8080, 'app-agree',    now()),
               ('d-3', 'c.example.com', 8080, 'app-disagree', now()),
               ('d-4', 'd.example.com', 9090, 'app-disagree', now()),
               ('d-5', 'e.example.com', null, 'app-default',  now());
    `);

    await legacy.migrateToHead();

    const { rows } = await legacy.pool.query<{
      application_id: string;
      port: number;
    }>('select application_id, port from application order by application_id');
    expect(
      Object.fromEntries(rows.map((r) => [r.application_id, r.port])),
    ).toEqual({
      'app-agree': 8080,
      'app-default': 3000,
      'app-disagree': 3000,
      'app-none': 3000,
    });
  });
});
