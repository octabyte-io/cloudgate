import { startLegacyDatabase } from '../utils/migrations-up-to';
import type { LegacyDatabase } from '../utils/migrations-up-to';

jest.setTimeout(180_000);

/** The last migration before the Instance organization was pinned. */
const MIGRATION_BEFORE_PIN = '0223_server-host-key-fingerprint';

/**
 * The migration that makes `instance_organization` back-fills it once
 * (ADR-0077) from the definition it replaces: the Organization of the earliest
 * owner `member` row. An install nobody has claimed pins nothing, so its first
 * sign-up or `create-instance-organization` does.
 */
describe('Instance organization pin back-fill (e2e)', () => {
  let claimed: LegacyDatabase;
  let unclaimed: LegacyDatabase;

  beforeAll(async () => {
    claimed = await startLegacyDatabase('pin_claimed', MIGRATION_BEFORE_PIN);
    unclaimed = await startLegacyDatabase(
      'pin_unclaimed',
      MIGRATION_BEFORE_PIN,
    );
  });

  afterAll(async () => {
    await claimed?.drop();
    await unclaimed?.drop();
  });

  it('pins the Organization of the earliest owner row on an existing install', async () => {
    await claimed.pool.query(`
      insert into "user" (id, email, updated_at)
        values ('u-staff', 'staff@example.com', now()),
               ('u-customer', 'customer@example.com', now());
      insert into organization (id, name, created_at, owner_id)
        values ('org-customer', 'Customer', '2026-02-01', 'u-customer'),
               ('org-staff', 'Staff', '2026-01-01', 'u-staff');
      insert into member (id, organization_id, user_id, role, created_at)
        values ('m-customer', 'org-customer', 'u-customer', 'owner', '2026-02-01'),
               ('m-staff', 'org-staff', 'u-staff', 'owner', '2026-01-01');
    `);

    await claimed.migrateToHead();

    const { rows } = await claimed.pool.query<{
      id: string;
      organization_id: string;
      pinned_at: string;
    }>('select id, organization_id, pinned_at from instance_organization');
    expect(
      rows.map(({ id, organization_id }) => ({ id, organization_id })),
    ).toEqual([{ id: 'instance', organization_id: 'org-staff' }]);
    expect(rows[0].pinned_at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    await expect(
      claimed.pool.query(`delete from organization where id = 'org-staff'`),
    ).rejects.toThrow(/instance_organization/);
  });

  it('pins nothing on an install nobody has claimed', async () => {
    await unclaimed.migrateToHead();

    const { rows } = await unclaimed.pool.query(
      'select * from instance_organization',
    );
    expect(rows).toEqual([]);
  });
});
