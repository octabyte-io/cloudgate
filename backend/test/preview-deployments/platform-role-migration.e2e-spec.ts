import { startLegacyDatabase } from '../utils/migrations-up-to';
import type { LegacyDatabase } from '../utils/migrations-up-to';

jest.setTimeout(180_000);

/** The last migration before no Member could hold `system`. */
const MIGRATION_BEFORE_THE_PLATFORM_ROLE = '0079_requested-preview-limit';

/**
 * The upgrade. `0080` refuses `system` on every `member` row
 * (`member_role_is_not_the_platform`), and before it a custom role could be
 * named `system` and held. A check added over such a row fails, and with it
 * the whole migration, so the install could not upgrade. The role is renamed
 * first, wherever it is named, and every holder keeps it under the new name.
 *
 * Against the migrator on a database whose history stops at `0079`, for the
 * reason `startLegacyDatabase` gives.
 */
describe('The platform role migration (e2e)', () => {
  let legacy: LegacyDatabase;

  beforeAll(async () => {
    legacy = await startLegacyDatabase(
      'i651',
      MIGRATION_BEFORE_THE_PLATFORM_ROLE,
    );
    await legacy.pool.query(`
      insert into "user" (id, email, updated_at) values
        ('user-1', 'grace@example.com', now()),
        ('user-2', 'ada@example.com', now()),
        ('user-3', 'alan@example.com', now()),
        ('user-4', 'edsger@example.com', now());
      insert into organization (id, name, created_at, owner_id) values
        ('org-1', 'Acme', now(), 'user-1'),
        ('org-2', 'Globex', now(), 'user-1');
      insert into organization_role (id, organization_id, role, permission) values
        ('role-1', 'org-1', 'system', '{"project":["read"]}'),
        ('role-2', 'org-2', 'system', '{"project":["read"]}'),
        ('role-3', 'org-2', 'system-renamed', '{}');
      insert into member (id, organization_id, user_id, role, created_at) values
        ('member-1', 'org-1', 'user-1', 'owner', now()),
        ('member-2', 'org-1', 'user-2', 'system', now()),
        ('member-3', 'org-1', 'user-3', 'member, system', now()),
        ('member-4', 'org-2', 'user-4', 'system', now());
      insert into invitation (id, organization_id, email, role, status, expires_at, inviter_id)
        values ('invite-1', 'org-1', 'kay@example.com', 'system', 'pending', now(), 'user-1');
    `);

    await legacy.migrateToHead();
  });

  afterAll(async () => {
    await legacy?.drop();
  });

  it('renames a custom role named system and moves its holders with it', async () => {
    const roles = await legacy.pool.query(
      `select id, role from organization_role order by id`,
    );
    expect(roles.rows).toEqual([
      { id: 'role-1', role: 'system-renamed' },
      // Where the Organization already had that name, the row's id decides.
      { id: 'role-2', role: 'system-renamed-role-2' },
      { id: 'role-3', role: 'system-renamed' },
    ]);
    const members = await legacy.pool.query(
      `select id, role from member order by id`,
    );
    expect(members.rows).toEqual([
      { id: 'member-1', role: 'owner' },
      { id: 'member-2', role: 'system-renamed' },
      { id: 'member-3', role: 'member,system-renamed' },
      { id: 'member-4', role: 'system-renamed-role-2' },
    ]);
    const invitations = await legacy.pool.query(`select role from invitation`);
    expect(invitations.rows).toEqual([{ role: 'system-renamed' }]);
  });

  it('then refuses system on a member row', async () => {
    await expect(
      legacy.pool.query(
        `update member set role = 'system' where id = 'member-1'`,
      ),
    ).rejects.toThrow(/member_role_is_not_the_platform/);
  });
});
