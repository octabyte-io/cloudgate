import { startLegacyDatabase } from '../utils/migrations-up-to';
import type { LegacyDatabase } from '../utils/migrations-up-to';

jest.setTimeout(180_000);

/** The last migration before Project and Environment names became unique. */
const MIGRATION_BEFORE_INDEX = '0070_drop-instance-ssh-key';

/**
 * `0071_project-environment-name-unique.sql` adds a unique index on
 * `(organization_id, lower(name))` to `project` and on
 * `(project_id, lower(name))` to `environment`. Every install before the fix could
 * hold two same-named rows in one parent — the U-run made both through the
 * console — so without the rename in front of the indexes the migration would
 * abort on somebody's database rather than on ours.
 *
 * Written against the migrator on a database whose history stops at `0070`,
 * for the reason `startLegacyDatabase` gives. The before-state is asserted
 * rather than assumed.
 */
describe('Project and Environment names are unique (e2e)', () => {
  let legacy: LegacyDatabase;

  beforeAll(async () => {
    legacy = await startLegacyDatabase('i0071', MIGRATION_BEFORE_INDEX);
  });

  afterAll(async () => {
    await legacy?.drop();
  });

  const names = async (table: 'project' | 'environment', idColumn: string) =>
    Object.fromEntries(
      (
        await legacy.pool.query<{ id: string; name: string }>(
          `select ${idColumn} as id, name from ${table} order by ${idColumn}`,
        )
      ).rows.map((row) => [row.id, row.name]),
    );

  it('renames every later duplicate to the first free `<name> (n)`, oldest keeps its name', async () => {
    await legacy.pool.query(`
      insert into "user" (id, email, updated_at)
        values ('user-1', 'grace@example.com', now());
      insert into organization (id, name, created_at, owner_id)
        values ('org-1', 'Acme', now(), 'user-1'),
               ('org-2', 'Globex', now(), 'user-1');
      -- 'p-a' sorts first by id and is the newest: the keeper is the oldest.
      -- 'ui-tags (2)' is already taken, so the copies step over it.
      insert into project (project_id, name, created_at, organization_id) values
        ('p-keep',  'ui-tags',     '2026-01-01T00:00:00.000Z', 'org-1'),
        ('p-taken', 'ui-tags (2)', '2026-01-02T00:00:00.000Z', 'org-1'),
        ('p-upper', 'UI-Tags',     '2026-01-03T00:00:00.000Z', 'org-1'),
        ('p-a',     ' ui-tags ',   '2026-01-04T00:00:00.000Z', 'org-1'),
        ('p-tie-b', 'tie',         '2026-01-01T00:00:00.000Z', 'org-1'),
        ('p-tie-a', 'tie',         '2026-01-01T00:00:00.000Z', 'org-1'),
        ('p-org2',  'ui-tags',     '2026-01-05T00:00:00.000Z', 'org-2');
      insert into environment (environment_id, name, created_at, project_id) values
        ('e-keep', 'staging',  '2026-01-01T00:00:00.000Z', 'p-keep'),
        ('e-copy', 'staging',  '2026-01-02T00:00:00.000Z', 'p-keep'),
        ('e-ops',  E'\\tops ', '2026-01-01T00:00:00.000Z', 'p-keep'),
        ('e-else', 'staging',  '2026-01-03T00:00:00.000Z', 'p-org2');
    `);
    expect(await names('project', 'project_id')).toMatchObject({
      'p-a': ' ui-tags ',
      'p-upper': 'UI-Tags',
    });

    await legacy.migrateToHead();

    expect(await names('project', 'project_id')).toEqual({
      'p-keep': 'ui-tags',
      'p-taken': 'ui-tags (2)',
      // Oldest copy first: the first free suffix is (3), then (4).
      'p-upper': 'UI-Tags (3)',
      // Trimmed first, and so a copy.
      'p-a': 'ui-tags (4)',
      // A created_at tie goes to the lower id.
      'p-tie-a': 'tie',
      'p-tie-b': 'tie (2)',
      // Another organization's `ui-tags` is its own name.
      'p-org2': 'ui-tags',
    });
    expect(await names('environment', 'environment_id')).toEqual({
      'e-keep': 'staging',
      'e-copy': 'staging (2)',
      'e-ops': 'ops',
      // Another Project's `staging` is its own name.
      'e-else': 'staging',
    });

    // And from here on the database refuses the pair itself.
    await expect(
      legacy.pool.query(
        `insert into project (project_id, name, created_at, organization_id)
           values ('p-new', 'TIE', '2026-02-01T00:00:00.000Z', 'org-1')`,
      ),
    ).rejects.toThrow(/unique_org_project_name/);
    await expect(
      legacy.pool.query(
        `insert into environment (environment_id, name, created_at, project_id)
           values ('e-new', 'Staging', '2026-02-01T00:00:00.000Z', 'p-keep')`,
      ),
    ).rejects.toThrow(/unique_project_environment_name/);
  });
});
