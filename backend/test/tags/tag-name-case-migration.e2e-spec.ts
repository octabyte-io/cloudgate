import { startLegacyDatabase } from '../utils/migrations-up-to';
import type { LegacyDatabase } from '../utils/migrations-up-to';

jest.setTimeout(180_000);

/** The last migration before a tag's name became unique regardless of case. */
const MIGRATION_BEFORE_INDEX = '0068_stopped-status';

interface TagRow {
  tag_id: string;
  organization_id: string;
  name: string;
}

interface Assignment {
  project_id: string;
  tag_id: string;
}

/**
 * `0069_tag-name-ignores-case.sql` swaps the byte-compared
 * `(organization_id, name)` unique for one on `(organization_id, lower(name))`.
 * `CREATE UNIQUE INDEX` validates the rows already stored, and every install
 * before the fix could hold `frontend` beside `Frontend` — the U-run made exactly
 * that pair through the console — so without the merge in front of it the
 * migration would abort on somebody's database rather than on ours.
 *
 * Written against the migrator on a database whose history stops at `0068`,
 * for the reason `startLegacyDatabase` gives: the template database replays
 * every migration before any row exists, so an ordinary suite watches `0069`
 * merge nothing. The before-state is asserted rather than assumed.
 */
describe('Tag names ignore case (e2e)', () => {
  let legacy: LegacyDatabase;

  beforeAll(async () => {
    legacy = await startLegacyDatabase('i0069', MIGRATION_BEFORE_INDEX);
  });

  afterAll(async () => {
    await legacy?.drop();
  });

  const tags = async () =>
    (
      await legacy.pool.query<TagRow>(
        'select tag_id, organization_id, name from tag order by tag_id',
      )
    ).rows;

  const assignments = async () =>
    (
      await legacy.pool.query<Assignment>(
        'select project_id, tag_id from project_tag order by project_id, tag_id',
      )
    ).rows;

  it('merges case- and space-variant tags into the oldest, keeping every assignment', async () => {
    await legacy.pool.query(`
      insert into "user" (id, email, updated_at)
        values ('user-1', 'grace@example.com', now());
      insert into organization (id, name, created_at, owner_id)
        values ('org-1', 'Acme', now(), 'user-1'),
               ('org-2', 'Globex', now(), 'user-1');
      insert into project (project_id, name, created_at, organization_id)
        values ('p-both', 'both', '2026-01-01T00:00:00.000Z', 'org-1'),
               ('p-late', 'late', '2026-01-01T00:00:00.000Z', 'org-1'),
               ('p-two-late', 'two-late', '2026-01-01T00:00:00.000Z', 'org-1');
      -- The keeper is the oldest of each group, not the first by id or by
      -- name: 't-a' sorts first and is the newest.
      insert into tag (tag_id, name, created_at, organization_id) values
        ('t-keep',  'frontend',   '2026-01-01T00:00:00.000Z', 'org-1'),
        ('t-upper', 'Frontend',   '2026-01-02T00:00:00.000Z', 'org-1'),
        ('t-a',     ' FRONTEND ', '2026-01-03T00:00:00.000Z', 'org-1'),
        ('t-ops',   E'\\tops ',   '2026-01-01T00:00:00.000Z', 'org-1'),
        ('t-org2',  'Frontend',   '2026-01-01T00:00:00.000Z', 'org-2');
      insert into project_tag (id, project_id, tag_id) values
        -- Carries the keeper and a variant: one assignment afterwards.
        ('pt-1', 'p-both', 't-keep'),
        ('pt-2', 'p-both', 't-upper'),
        -- Carries only a variant: it moves to the keeper.
        ('pt-3', 'p-late', 't-upper'),
        -- Carries two variants and not the keeper: one move, not two.
        ('pt-4', 'p-two-late', 't-upper'),
        ('pt-5', 'p-two-late', 't-a'),
        ('pt-6', 'p-two-late', 't-ops');
    `);
    expect((await tags()).map((row) => row.name)).toEqual([
      ' FRONTEND ',
      'frontend',
      '\tops ',
      'Frontend',
      'Frontend',
    ]);

    await legacy.migrateToHead();

    expect(await tags()).toEqual([
      { tag_id: 't-keep', organization_id: 'org-1', name: 'frontend' },
      // A name that was only untrimmed is trimmed, like the DTO now trims.
      { tag_id: 't-ops', organization_id: 'org-1', name: 'ops' },
      // Another organization's `Frontend` is its own name.
      { tag_id: 't-org2', organization_id: 'org-2', name: 'Frontend' },
    ]);
    expect(await assignments()).toEqual([
      { project_id: 'p-both', tag_id: 't-keep' },
      { project_id: 'p-late', tag_id: 't-keep' },
      { project_id: 'p-two-late', tag_id: 't-keep' },
      { project_id: 'p-two-late', tag_id: 't-ops' },
    ]);

    // And from here on the database refuses the pair itself.
    await expect(
      legacy.pool.query(
        `insert into tag (tag_id, name, created_at, organization_id)
           values ('t-new', 'FRONTEND', '2026-02-01T00:00:00.000Z', 'org-1')`,
      ),
    ).rejects.toThrow(/unique_org_tag_name/);
  });
});
