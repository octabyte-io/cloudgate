import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MIGRATIONS_FOLDER,
  startLegacyDatabase,
} from '../utils/migrations-up-to';
import type { LegacyDatabase } from '../utils/migrations-up-to';

/**
 * The residual 91ee164 named. That fix closed both paths a legacy
 * `rollback.full_context` could be *read* through — `toRollbackContext` runs
 * on the way out as well as on the way in — and could not touch the bytes at
 * rest: a row written before that commit still holds decrypted `previewEnv`,
 * `previewBuildArgs`, each file mount's `content` and the seven credential
 * ids, one of which a pre-fix Application row could legitimately hold for
 * another organization, in a plain `json` column that any `pg_dump` copies.
 * `0062` is the one-time scrub.
 *
 * **Written against the migrator, not against the SQL.** The harness's
 * template database has every migration already replayed into it before any
 * test data exists (`test/utils/global-setup.ts` calls
 * `createTemplateDatabase`, which is a real `migrate()` over `drizzle/`), so
 * `0062` runs there against an empty `rollback` table and an ordinary suite
 * cannot observe it doing anything. A database whose history *stops* before
 * the scrub is the only place legacy rows can be written and then migrated
 * over, so this file builds one — `startLegacyDatabase`, whose own docblock
 * carries the technique and why the shared server is the whole of it
 * (this file and `patch/parent-id-constraint.e2e-spec.ts` each held a copy of
 * it, and `databases/mariadb-image-migration.e2e-spec.ts` held the original).
 */

/** The last migration before the scrub. */
const MIGRATION_BEFORE_SCRUB = '0061_license-lapse-flag';
const SCRUB = '0062_scrub-legacy-rollback-context';

/** A snapshot as `capture` wrote one before 91ee164, keyed by rollback id. */
const LEGACY_CONTEXT: Record<string, unknown> = {
  'legacy-full': {
    applicationId: 'app-1',
    appName: 'shop-api',
    replicas: 2,
    // The seven ids an earlier fix proved were the live exposure. `reg-victim` is the
    // case that makes this a security issue rather than hygiene: before the fix
    // an Application could be pointed at another organization's registry, so
    // this id in this column is a cross-organization reference at rest.
    githubId: 'gh-1',
    gitlabId: 'gl-1',
    giteaId: 'gt-1',
    bitbucketId: 'bb-1',
    customGitSSHKeyId: 'key-1',
    registryId: 'reg-victim',
    buildRegistryId: 'reg-2',
    // `encryptedText` on `application`, cleartext here (ADR 0006).
    previewEnv: 'STRIPE_SECRET=sk_live_318',
    previewBuildArgs: 'NPM_TOKEN=npm_318',
    // Whole `mount` rows, as `findDeployable` fills them.
    mounts: [
      {
        mountId: 'mount-1',
        type: 'file',
        mountPath: '/app/.env',
        filePath: '.env',
        volumeName: null,
        hostPath: null,
        content: 'DB_PASSWORD=hunter2',
        serviceType: 'application',
        applicationId: 'app-1',
      },
      {
        mountId: 'mount-2',
        type: 'volume',
        mountPath: '/data',
        filePath: null,
        volumeName: 'shop-data',
        hostPath: null,
        serviceType: 'application',
        applicationId: 'app-1',
      },
    ],
  },
  'mounts-null': { appName: 'a', registryId: 'reg-3', mounts: null },
  'mounts-empty': { appName: 'b', previewEnv: 'A=b', mounts: [] },
  // `full_context` is whatever some past version of `capture` wrote, and
  // `json` accepts a scalar and an array as readily as an object. Both are
  // here because `jsonb - text[]` answers a scalar with `cannot delete from
  // scalar` — which inside a migration is the whole run aborting — and
  // answers an *array* by deleting matching string elements, which is silent
  // corruption.
  scalar: 42,
  array: ['registryId', 'keep'],
};

interface Row {
  rollback_id: string;
  raw: string | null;
  parsed: Record<string, unknown> | null;
}

describe('Legacy rollback context scrub (e2e)', () => {
  let legacy: LegacyDatabase;
  let before: Row[];
  let after: Row[];
  let afterSecondRun: Row[];
  let secondRunRowCounts: (number | null)[];

  const readRows = async (): Promise<Row[]> => {
    const { rows } = await legacy.pool.query<Row>(
      `select rollback_id, full_context::text as raw, full_context as parsed
         from rollback order by rollback_id`,
    );
    return rows;
  };

  const row = (rows: Row[], id: string): Row => {
    const found = rows.find((candidate) => candidate.rollback_id === id);
    // A fixture with no row behind it makes every `not.toHaveProperty` below
    // pass against a migration that does nothing at all.
    expect(found).toBeDefined();
    return found as Row;
  };

  beforeAll(async () => {
    // Deliberately not the run's template database: its history already
    // includes the scrub, and a database that has run 0062 cannot show 0062
    // running. `startLegacyDatabase` says so once.
    legacy = await startLegacyDatabase('i318', MIGRATION_BEFORE_SCRUB);

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
      insert into deployment (deployment_id, title, log_path, created_at, application_id)
        values ('dep-1', 'Deploy', '/var/log/dep-1', '2026-01-01T00:00:00.000Z', 'app-1');
    `);

    // A `full_context` that is SQL NULL as well as the five JSON shapes: the
    // column is nullable and `capture` leaves it null until the image lands.
    await legacy.pool.query(
      `insert into rollback (rollback_id, deployment_id, image, full_context, created_at)
         values ('context-null', 'dep-1', 'shop-api:v1', null, '2026-01-01T00:00:00.000Z')`,
    );
    for (const [id, context] of Object.entries(LEGACY_CONTEXT)) {
      await legacy.pool.query(
        `insert into rollback (rollback_id, deployment_id, image, full_context, created_at)
           values ($1, 'dep-1', 'shop-api:v1', $2::json, '2026-01-01T00:00:00.000Z')`,
        [id, JSON.stringify(context)],
      );
    }

    before = await readRows();

    // The scrub, through the migrator that runs it in production.
    await legacy.migrateToHead();
    after = await readRows();

    // And again, from the committed file, because `migrate()` will not replay
    // a migration whose journal row it has already written — the idempotence
    // claim is about the statements, so it is the statements that get run
    // twice.
    const statements = (
      await readFile(join(MIGRATIONS_FOLDER, `${SCRUB}.sql`), 'utf8')
    )
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    expect(statements).toHaveLength(2);
    secondRunRowCounts = [];
    for (const statement of statements) {
      const result = await legacy.pool.query(statement);
      secondRunRowCounts.push(result.rowCount);
    }
    afterSecondRun = await readRows();
  }, 180_000);

  afterAll(async () => {
    await legacy?.drop();
  });

  it('holds every secret in cleartext before the scrub runs', () => {
    // The before state, asserted rather than assumed: a fixture that never
    // carried the keys would make the whole file green against an empty
    // migration.
    expect(row(before, 'legacy-full').parsed).toMatchObject({
      registryId: 'reg-victim',
      buildRegistryId: 'reg-2',
      githubId: 'gh-1',
      gitlabId: 'gl-1',
      giteaId: 'gt-1',
      bitbucketId: 'bb-1',
      customGitSSHKeyId: 'key-1',
      previewEnv: 'STRIPE_SECRET=sk_live_318',
      previewBuildArgs: 'NPM_TOKEN=npm_318',
    });
    expect(row(before, 'legacy-full').raw).toContain('DB_PASSWORD=hunter2');
  });

  it.each([
    'githubId',
    'gitlabId',
    'giteaId',
    'bitbucketId',
    'customGitSSHKeyId',
    'registryId',
    'buildRegistryId',
  ])('leaves no %s in a snapshot the scrub has run over', (key) => {
    expect(row(after, 'legacy-full').parsed).not.toHaveProperty(key);
  });

  it.each(['previewEnv', 'previewBuildArgs'])(
    'leaves no decrypted %s in a snapshot the scrub has run over',
    (key) => {
      expect(row(after, 'legacy-full').parsed).not.toHaveProperty(key);
    },
  );

  it('leaves the config columns a rollback redeploys with', () => {
    // Without this the file passes against `set full_context = '{}'`.
    expect(row(after, 'legacy-full').parsed).toMatchObject({
      applicationId: 'app-1',
      appName: 'shop-api',
      replicas: 2,
    });
  });

  it('drops each mount content and keeps the rest of the mount, in order', () => {
    const mounts = (row(after, 'legacy-full').parsed as { mounts: unknown[] })
      .mounts;

    // Only `content` — the one `encryptedText` column on `mount` — and not a
    // projection down to `ServiceMount`'s five fields the way
    // `toSnapshotMount` does on the write path. The exposure being scrubbed is
    // the secret bytes; `mountId` and the rest are not secret, and a migration
    // that deleted them would be changing data at rest for a reason the issue
    // does not have. Readers get the five-field projection regardless, because
    // an earlier fix made `findAllByApplicationId` re-strip on the way out.
    expect(mounts).toEqual([
      {
        mountId: 'mount-1',
        type: 'file',
        mountPath: '/app/.env',
        filePath: '.env',
        volumeName: null,
        hostPath: null,
        serviceType: 'application',
        applicationId: 'app-1',
      },
      {
        mountId: 'mount-2',
        type: 'volume',
        mountPath: '/data',
        filePath: null,
        volumeName: 'shop-data',
        hostPath: null,
        serviceType: 'application',
        applicationId: 'app-1',
      },
    ]);
    expect(row(after, 'legacy-full').raw).not.toContain('DB_PASSWORD=hunter2');
  });

  it('leaves a null mounts array null while still scrubbing the row', () => {
    // The mounts half must be a no-op for a shape it was not written for, and
    // `jsonb_array_elements` answers a JSON null with `cannot extract elements
    // from a scalar` — an aborted migration run, not a skipped row.
    expect(row(after, 'mounts-null').parsed).toEqual({
      appName: 'a',
      mounts: null,
    });
  });

  it('leaves an empty mounts array empty rather than nulling it', () => {
    // `jsonb_agg` over no rows is SQL NULL, so a mounts rewrite that reached
    // `[]` would write `"mounts": null` and call it unchanged.
    expect(row(after, 'mounts-empty').parsed).toEqual({
      appName: 'b',
      mounts: [],
    });
  });

  it('leaves a null full_context null', () => {
    expect(row(after, 'context-null').raw).toBeNull();
  });

  it.each(['scalar', 'array'])(
    'leaves a full_context that is a %s exactly as it found it',
    (id) => {
      // That the run reached these assertions at all is the other half: a
      // statement guarded only on `full_context IS NOT NULL` raises `cannot
      // delete from scalar` here, which fails the migration and every suite
      // after it, and on the array it would silently delete the element
      // `"registryId"`.
      expect(row(after, id).raw).toBe(row(before, id).raw);
    },
  );

  it('changes nothing on a second run', () => {
    expect(secondRunRowCounts).toEqual([0, 0]);
    expect(afterSecondRun).toEqual(after);
  });
});
