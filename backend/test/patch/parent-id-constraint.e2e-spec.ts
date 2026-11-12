import { startLegacyDatabase } from '../utils/migrations-up-to';
import type { LegacyDatabase } from '../utils/migrations-up-to';

/**
 * The second half of the parent-column sweep: `CHECK ((application_id IS NULL) <>
 * (compose_id IS NULL))` on `patch` and on `domain`, which an earlier fix named
 * and declined to build because it needs a migration.
 *
 * `0063_exactly-one-parent-id.sql` does two things and this suite is about
 * both, in the order a real install experiences them:
 *
 * 1. **It normalizes the rows that already exist.** A row carrying *both*
 *    parents was producible on every build older than the patch fix (`patch`) and
 *    the domain fix (`domain`) — an owned `applicationId` beside another organization's
 *    `composeId`, which is the cross-tenant write both issues were filed
 *    about. `ADD CONSTRAINT` validates existing rows, so without the two
 *    `UPDATE`s the migration would abort on somebody's database rather than
 *    ours. The `UPDATE`s clear `compose_id`, which is what makes the stored
 *    row agree with what every reader in both modules already resolves it as
 *    — `PatchService`' `serviceIdOf` is `row.applicationId ?? row.composeId`,
 *    and `DomainsService.findParentService` tests `applicationId` first and
 *    returns — and takes the patch or the Traefik router off the Compose stack
 *    that never authorized it.
 * 2. **It makes the row shape unstorable from then on**, which is the only
 *    version of this rule a *fourth* write path cannot get wrong. The DTO
 *    refinements stay: a `CHECK` violation is a 500 naming a constraint, and a
 *    caller needs the 400 at a field path that `createPatchSchema` and
 *    `createDomainSchema` give them.
 *
 * **Written against the migrator, not against the SQL**, on
 * `legacy-context-scrub.e2e-spec.ts`' terms and for its reason: the harness's
 * template database has every migration replayed into it before any test data
 * exists (`test/utils/global-setup.ts` → `createTemplateDatabase`), so `0063`
 * runs there against empty tables and an ordinary suite cannot observe it
 * normalizing anything. A database whose history *stops* at `0062` is the only
 * place a legacy both-parents row can be written and then migrated over, so
 * this file builds one on the server the run already shares — what it needs is
 * a *history*, which is per-database, and a container of its own would cost the
 * run a gigabyte and buy nothing. `startLegacyDatabase` is that build, shared
 * with the tree's other two migration proofs.
 *
 * The before-state is asserted rather than assumed: a fixture that never
 * carried both keys would make every assertion below pass against a migration
 * that does nothing at all.
 */

/** The last migration before the constraint. */
const MIGRATION_BEFORE_CONSTRAINT = '0062_scrub-legacy-rollback-context';

interface Parents {
  id: string;
  application_id: string | null;
  compose_id: string | null;
}

describe('Exactly one parent id (e2e)', () => {
  let legacy: LegacyDatabase;
  let patchesBefore: Parents[];
  let patchesAfter: Parents[];
  let domainsBefore: Parents[];
  let domainsAfter: Parents[];

  const readPatches = async (): Promise<Parents[]> =>
    (
      await legacy.pool.query<Parents>(
        `select patch_id as id, application_id, compose_id
           from patch order by patch_id`,
      )
    ).rows;

  const readDomains = async (): Promise<Parents[]> =>
    (
      await legacy.pool.query<Parents>(
        `select domain_id as id, application_id, compose_id
           from domain order by domain_id`,
      )
    ).rows;

  const row = (rows: Parents[], id: string): Parents => {
    const found = rows.find((candidate) => candidate.id === id);
    expect(found).toBeDefined();
    return found as Parents;
  };

  /** The error a write is refused with, or `null` if it was accepted. */
  const refusal = async (statement: string): Promise<string | null> => {
    try {
      await legacy.pool.query(statement);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  };

  beforeAll(async () => {
    // Deliberately not the run's template database: its history already
    // includes the constraint, and a database that has run 0063 cannot store
    // the row 0063 has to normalize. `startLegacyDatabase` says so once.
    legacy = await startLegacyDatabase('i314', MIGRATION_BEFORE_CONSTRAINT);

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
        application_id, name, app_name, created_at, environment_id
      ) values ('app-1', 'Shop API', 'shop-api', '2026-01-01T00:00:00.000Z', 'env-1');
      insert into compose (compose_id, name, app_name, created_at, environment_id)
        values ('stack-1', 'Edge', 'edge-stack', '2026-01-01T00:00:00.000Z', 'env-1');
    `);

    // The pre-fix shape: the caller's own `applicationId` beside a
    // `composeId` they were never authorized for. `patch.content` is an
    // `encryptedText` column, so its bytes are opaque here and irrelevant —
    // what this suite reads is the two foreign keys.
    await legacy.pool.query(`
      insert into patch (patch_id, file_path, content, created_at, application_id, compose_id)
        values ('patch-both', 'src/app.ts', 'x', '2026-01-01T00:00:00.000Z', 'app-1', 'stack-1');
      insert into patch (patch_id, file_path, content, created_at, application_id)
        values ('patch-app', 'src/one.ts', 'x', '2026-01-01T00:00:00.000Z', 'app-1');
      insert into patch (patch_id, file_path, content, created_at, compose_id)
        values ('patch-stack', 'src/two.ts', 'x', '2026-01-01T00:00:00.000Z', 'stack-1');
      insert into domain (domain_id, host, created_at, application_id, compose_id)
        values ('domain-both', 'both.example.com', '2026-01-01T00:00:00.000Z', 'app-1', 'stack-1');
      insert into domain (domain_id, host, created_at, application_id)
        values ('domain-app', 'app.example.com', '2026-01-01T00:00:00.000Z', 'app-1');
      insert into domain (domain_id, host, created_at, compose_id)
        values ('domain-stack', 'edge.example.com', '2026-01-01T00:00:00.000Z', 'stack-1');
    `);

    patchesBefore = await readPatches();
    domainsBefore = await readDomains();

    // The constraint, through the migrator that applies it in production.
    await legacy.migrateToHead();
    patchesAfter = await readPatches();
    domainsAfter = await readDomains();
  }, 180_000);

  afterAll(async () => {
    await legacy?.drop();
  });

  it('stores a row carrying both parents on a history that stops before the constraint', () => {
    // The before state. Without this, a `patch` table that never held the row
    // would make the normalization assertions below green against a migration
    // that only ran the two ALTERs.
    expect(row(patchesBefore, 'patch-both')).toEqual({
      id: 'patch-both',
      application_id: 'app-1',
      compose_id: 'stack-1',
    });
    expect(row(domainsBefore, 'domain-both')).toEqual({
      id: 'domain-both',
      application_id: 'app-1',
      compose_id: 'stack-1',
    });
  });

  it('narrows a both-parents row to the Application every reader already resolved it as', () => {
    // Not deleted, and `application_id` not the key cleared: the row goes on
    // being the Application patch/domain that `serviceIdOf` and
    // `findParentService` have always read it as, and stops reaching the
    // Compose stack that never authorized it.
    expect(row(patchesAfter, 'patch-both')).toEqual({
      id: 'patch-both',
      application_id: 'app-1',
      compose_id: null,
    });
    expect(row(domainsAfter, 'domain-both')).toEqual({
      id: 'domain-both',
      application_id: 'app-1',
      compose_id: null,
    });
  });

  it('leaves every single-parent row exactly as it was', () => {
    // The normalization is keyed to `application_id IS NOT NULL AND compose_id
    // IS NOT NULL`; an UPDATE missing that predicate would detach every
    // compose patch and every compose domain on the instance.
    expect([
      row(patchesAfter, 'patch-app'),
      row(patchesAfter, 'patch-stack'),
      row(domainsAfter, 'domain-app'),
      row(domainsAfter, 'domain-stack'),
    ]).toEqual([
      row(patchesBefore, 'patch-app'),
      row(patchesBefore, 'patch-stack'),
      row(domainsBefore, 'domain-app'),
      row(domainsBefore, 'domain-stack'),
    ]);
  });

  it('refuses a new row carrying both parents, on both tables', async () => {
    // The rule as a database fact. This is the write two earlier fixes each closed
    // at the application layer for one table; from here it is closed for every
    // write path, including one written next month that reaches the table
    // directly.
    const refusals = {
      patch: await refusal(
        `insert into patch (patch_id, file_path, content, created_at, application_id, compose_id)
           values ('patch-new-both', 'src/new.ts', 'x', '2026-02-01T00:00:00.000Z', 'app-1', 'stack-1')`,
      ),
      domain: await refusal(
        `insert into domain (domain_id, host, created_at, application_id, compose_id)
           values ('domain-new-both', 'new.example.com', '2026-02-01T00:00:00.000Z', 'app-1', 'stack-1')`,
      ),
    };

    expect(refusals.patch).toContain('patch_exactly_one_parent');
    expect(refusals.domain).toContain('domain_exactly_one_parent');
  });

  it('refuses a row carrying neither parent, on both tables', async () => {
    // `<>` is XOR, so the orphan is refused too. Neither module can resolve
    // one — `serviceIdOf` raises a 500 for it and
    // `DomainsService.findParentService` a 400 — and no code path in this
    // repository's history could produce one, both of which are argued at the
    // constraint's own docblock.
    const refusals = {
      patch: await refusal(
        `insert into patch (patch_id, file_path, content, created_at)
           values ('patch-orphan', 'src/orphan.ts', 'x', '2026-02-01T00:00:00.000Z')`,
      ),
      domain: await refusal(
        `insert into domain (domain_id, host, created_at)
           values ('domain-orphan', 'orphan.example.com', '2026-02-01T00:00:00.000Z')`,
      ),
    };

    expect(refusals.patch).toContain('patch_exactly_one_parent');
    expect(refusals.domain).toContain('domain_exactly_one_parent');
  });

  it('still accepts a row with exactly one parent, either side, on both tables', async () => {
    // The positive control. A constraint that refused everything would satisfy
    // both assertions above and break `POST /patches` and `POST /domains`
    // outright.
    const accepted = {
      patchOnApplication: await refusal(
        `insert into patch (patch_id, file_path, content, created_at, application_id)
           values ('patch-ok-app', 'src/ok-a.ts', 'x', '2026-02-01T00:00:00.000Z', 'app-1')`,
      ),
      patchOnCompose: await refusal(
        `insert into patch (patch_id, file_path, content, created_at, compose_id)
           values ('patch-ok-stack', 'src/ok-c.ts', 'x', '2026-02-01T00:00:00.000Z', 'stack-1')`,
      ),
      domainOnApplication: await refusal(
        `insert into domain (domain_id, host, created_at, application_id)
           values ('domain-ok-app', 'ok-a.example.com', '2026-02-01T00:00:00.000Z', 'app-1')`,
      ),
      domainOnCompose: await refusal(
        `insert into domain (domain_id, host, created_at, compose_id)
           values ('domain-ok-stack', 'ok-c.example.com', '2026-02-01T00:00:00.000Z', 'stack-1')`,
      ),
    };

    expect(accepted).toEqual({
      patchOnApplication: null,
      patchOnCompose: null,
      domainOnApplication: null,
      domainOnCompose: null,
    });
  });

  it('refuses an update that would give an existing row a second parent', async () => {
    // The other direction, and not covered by either DTO: `updatePatchSchema`
    // and `updateDomainSchema` both omit the two ids and strip them off a body
    // that sends them anyway (, each pinned by a test), so the wire
    // cannot re-point a row — but an internal writer could, and an earlier fix narrowed
    // `PatchService.updateRow`'s parameter for exactly that reason. From here
    // the column rule holds for the `set` as well as the `insert`.
    const refusals = {
      patch: await refusal(
        `update patch set compose_id = 'stack-1' where patch_id = 'patch-app'`,
      ),
      domain: await refusal(
        `update domain set compose_id = 'stack-1' where domain_id = 'domain-app'`,
      ),
    };

    expect(refusals.patch).toContain('patch_exactly_one_parent');
    expect(refusals.domain).toContain('domain_exactly_one_parent');
  });
});
