import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import request from 'supertest';
import { App } from 'supertest/types';
import { BackupsService } from '../../src/backups/backups.service';
import type { ComposeBackupMetadata } from '../../src/backups/backup.schema';
import { ComposeService } from '../../src/compose/compose.service';
import * as schema from '../../src/db/schema';
import { DestinationsService } from '../../src/destinations/destinations.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { startLegacyDatabase } from '../utils/migrations-up-to';
import type { LegacyDatabase } from '../utils/migrations-up-to';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

/**
 * A **compose** backup keeps its target engine's credentials in the row —
 * the engine runs inside the user's stack, so there is no database row to read
 * them from — and three of `ComposeBackupMetadata`'s four members are a
 * password. `BackupsService.credentialsFor` hands them to `mariadb-dump`,
 * `mysqldump` and `mongodump`, on the dump path and the restore path alike —
 * as `--password=…` and `-p …` when this was written, which is what the
 * never-carry change then found: a value this spec had just made ciphertext at
 * rest was still a word of the command string `ExecError` journals. Those three
 * now read it out of `$CLOUDGATE_DB_PASSWORD` instead. They sat in cleartext `jsonb`,
 * where every engine table's own copy of the identical value has been
 * `encryptedText` since it was written. `0066` converts the column to
 * `encryptedJson`.
 *
 * **Why a spec of its own, and why it goes at the bytes.** `encryptedJson`
 * `dataType()`s to `'text'`, so nothing else in the tree can tell it from a
 * plain column: the compiler sees the same `ComposeBackupMetadata` either way,
 * `drizzle-kit`'s snapshot records `"type": "text"` for both, and every
 * existing backups assertion matches on the emitted dump command — which is
 * plaintext before and after, because that is the whole point of decrypting on
 * read. So a revert of this column would ship green through
 * `backups.e2e-spec.ts`, `backup-script.spec.ts` and
 * `backup-shell-safety.spec.ts` together. `metrics-config-at-rest.e2e-spec.ts`
 * and `gitlab.e2e-spec.ts` are the precedents, and the
 * declaration is held separately by
 * `test/coding-standards/secret-bearing-columns.spec.ts`' census.
 *
 * **Three claims, and the third is the one this column adds over the earlier
 * at-rest columns'.** The bytes at rest are ciphertext; a legacy row is read
 * anyway (ADR 0006's pass-through, since no migration can re-encrypt); and **the
 * nullable path works with no guard in `encryptedJson`**, because `metadata` is `null` on
 * every database backup — which is all of them but the compose ones. drizzle
 * never hands `null` to a `customType` (`utils.js`' `mapResultRow` and
 * `relations.js`' relational mapper both short-circuit it on the way out,
 * `sql.js` does on the way in), so the guard the conversion looked like it
 * needed is not one. Asserting the round trip is how that stays true rather
 * than being a claim about a dependency's internals.
 *
 * The last half needs a database whose history stops at `0065`: the run's
 * template has already replayed `0066`, so a legacy `jsonb` row cannot be
 * written there. `startLegacyDatabase` carries that technique.
 */
const MIGRATION_BEFORE = '0065_encrypt-metrics-config';

/** All three passwords at once, so a partial encryption cannot pass. */
const STACK_CREDENTIALS = {
  mariadb: { databaseUser: 'maria_user', databasePassword: 'maria-pw-351' },
  mongo: { databaseUser: 'mongo_user', databasePassword: 'mongo-pw-351' },
  mysql: { databaseRootPassword: 'mysql-root-pw-351' },
} satisfies ComposeBackupMetadata;

const PASSWORDS = [
  'maria-pw-351',
  'mongo-pw-351',
  'mysql-root-pw-351',
] as const;

describe('Backup metadata encryption at rest (e2e)', () => {
  describe('the bytes the driver writes', () => {
    let ctx: TestAppContext;
    let server: App;
    let backups: BackupsService;

    const execMock = {
      execAsync: jest.fn(),
      execAsyncRemote: jest.fn(),
      execFileAsync: jest.fn(),
    };

    beforeAll(async () => {
      ctx = await createTestApp({
        overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
      });
      server = ctx.app.getHttpServer() as App;
      backups = ctx.app.get(BackupsService);
    });

    afterAll(async () => {
      await ctx.teardown();
    });

    beforeEach(async () => {
      await ctx.resetDb();
      execMock.execAsync
        .mockReset()
        .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
      execMock.execAsyncRemote
        .mockReset()
        .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    });

    /** An owner, a stack, an engine row and a destination to back up to. */
    async function setUp() {
      const signUp = await request(server)
        .post('/api/auth/sign-up/email')
        .send({
          name: 'Grace Hopper',
          email: 'grace@example.com',
          password: 'super-secret-password',
        });
      expect(signUp.status).toBe(200);
      const cookie = signUp.headers['set-cookie'];
      const userId = (signUp.body as { user: { id: string } }).user.id;

      const orgs = await request(server)
        .get('/organizations')
        .set('Cookie', cookie);
      const organizationId = (orgs.body as { id: string }[])[0].id;
      const ownerCtx = {
        user: { id: userId },
        session: { activeOrganizationId: organizationId },
      };

      const project = await ctx.app
        .get(ProjectsService)
        .create(ownerCtx, { name: 'cloudgate' });
      const environment = await ctx.app
        .get(EnvironmentsService)
        .create(ownerCtx, { name: 'production', projectId: project.projectId });
      const stack = await ctx.app.get(ComposeService).create(ownerCtx, {
        name: 'Shop Stack',
        appName: 'shop-stack',
        environmentId: environment.environmentId,
      });
      const database = await ctx.app.get(PostgresService).create(ownerCtx, {
        name: 'Main DB',
        appName: 'main-db',
        databaseName: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 'sup3rS3cret',
        environmentId: environment.environmentId,
      });
      const destination = await ctx.app
        .get(DestinationsService)
        .create(ownerCtx, {
          name: 'prod-backups',
          provider: 'Cloudflare',
          accessKey: 'AKIAEXAMPLEACCESSKEY',
          secretAccessKey: 'wJalrXUtnFEMI-example-secret-key',
          bucket: 'cloudgate-backups',
          region: 'auto',
          endpoint: 'https://accountid.r2.cloudflarestorage.com',
        });

      return { cookie, ownerCtx, stack, database, destination };
    }

    const rawMetadata = async (backupId: string): Promise<string | null> => {
      const { rows } = await ctx.db.$client.query<{ metadata: string | null }>(
        'select metadata from backup where backup_id = $1',
        [backupId],
      );
      expect(rows).toHaveLength(1);
      return rows[0].metadata;
    };

    it("stores a compose backup's stack credentials as ciphertext and reads them back whole", async () => {
      const { cookie, stack, destination } = await setUp();

      const created = await request(server)
        .post('/backups')
        .set('Cookie', cookie)
        .send({
          schedule: '0 3 * * *',
          prefix: 'daily',
          database: 'shop',
          databaseType: 'mysql',
          backupType: 'compose',
          serviceId: stack.composeId,
          serviceName: 'db',
          metadata: STACK_CREDENTIALS,
          destinationId: destination.destinationId,
        });
      expect(created.status).toBe(201);
      const { backupId } = created.body as { backupId: string };

      const raw = await rawMetadata(backupId);
      // `not.toContain` as well as the prefix test, and all three passwords:
      // a `toDriver` that returned its input unchanged would still be `text`
      // in a `text` column, and only the absence of the plaintext says the
      // encryption ran. The earlier at-rest assertion is the model.
      for (const password of PASSWORDS) {
        expect(raw).not.toContain(password);
      }
      expect(raw?.startsWith('enc:v1:')).toBe(true);

      // And the whole structure survives the round trip, not just one
      // password — `encryptedJson` serializes the blob, so a broken
      // `fromDriver` loses every field at once rather than one.
      const [row] = await ctx.db.select().from(schema.backup);
      expect(row.metadata).toEqual(STACK_CREDENTIALS);
    });

    it('keeps the credentials the dump command runs as in plaintext on the wire to the host', async () => {
      // The other half, and the reason ADR 0015 insists on both: a column that
      // encrypts correctly and ships `enc:v1:…` into `mysqldump --password=`
      // is a silently broken backup, and every other assertion in this module
      // matches on the *path* rather than on the payload — so nothing else
      // would have said so. The value reaching the engine is the operator's.
      //
      // **One engine's object rather than {@link STACK_CREDENTIALS}' three**,
      // and worth saying because the first draft of this test asserted the
      // wrong password: `credentialsFor` resolves
      // `mariadb ?? mongo ?? mysql`, so a blob carrying all three runs a
      // `mysql` dump with the *mariadb* password. That precedence is
      // `composeMetadataSchema`'s to argue — it does, at length, for the
      // `databaseUser` chain of the same shape — and a test of the column has
      // no business restating it. Sending only the engine under test makes
      // this assertion about the driver boundary and nothing else.
      const { cookie, stack, destination, ownerCtx } = await setUp();

      const created = await request(server)
        .post('/backups')
        .set('Cookie', cookie)
        .send({
          schedule: '0 3 * * *',
          prefix: 'daily',
          database: 'shop',
          databaseType: 'mysql',
          backupType: 'compose',
          serviceId: stack.composeId,
          serviceName: 'db',
          metadata: { mysql: STACK_CREDENTIALS.mysql },
          destinationId: destination.destinationId,
        });
      expect(created.status).toBe(201);

      await backups.runManual(
        ownerCtx,
        (created.body as { backupId: string }).backupId,
      );

      // **Where the plaintext arrives moved with the never-carry change, and the
      // property did not.** The value used to be a word of this script —
      // `mysqldump --password=mysql-root-pw-351` — which is exactly why the change
      // was filed: `ExecError` captures the command and pino writes it six
      // times, so the column was ciphertext at rest and cleartext in the
      // journal. It now travels in the environment the script is executed
      // with, so this asserts the same thing one argument over: the operator's
      // own value, decrypted, reaching the host — and the command itself no
      // longer carrying it.
      const [script, options] = execMock.execAsync.mock.calls[1] as [
        string,
        { env: Record<string, string> },
      ];
      expect(options.env.CLOUDGATE_DB_PASSWORD).toBe('mysql-root-pw-351');
      expect(options.env.CLOUDGATE_DB_PASSWORD).not.toContain('enc:v1:');
      expect(script).toContain('--password="$CLOUDGATE_DB_PASSWORD"');
      expect(script).not.toContain('mysql-root-pw-351');
      expect(script).not.toContain('enc:v1:');
    });

    it('stores SQL NULL for a database backup and reads it back as null', async () => {
      // The nullable path, which is what `backup.metadata` adds over the earlier two
      // `notNull` columns: a database backup takes its credentials off the
      // engine row, so this column is `null` on every one of them — the
      // overwhelming majority of rows in the product. drizzle short-circuits
      // `null` before either mapper runs, so `encryptedJson` needs no guard of
      // its own; this is that claim, at the bytes and through the column, and
      // it is what a guard would have been added to make true.
      const { cookie, database, destination } = await setUp();

      const created = await request(server)
        .post('/backups')
        .set('Cookie', cookie)
        .send({
          schedule: '0 4 * * *',
          prefix: 'engine-daily',
          database: 'shop',
          databaseType: 'postgres',
          serviceId: database.postgresId,
          destinationId: destination.destinationId,
        });
      expect(created.status).toBe(201);
      const { backupId } = created.body as { backupId: string };

      expect(await rawMetadata(backupId)).toBeNull();

      // Both read paths, because they map rows through different code:
      // `select()` goes through `mapResultRow` and `db.query` through the
      // relational mapper, and only one of the two is exercised by the
      // assertion above it.
      const [row] = await ctx.db.select().from(schema.backup);
      expect(row.metadata).toBeNull();
      const single = await request(server)
        .get(`/backups/${backupId}`)
        .set('Cookie', cookie);
      expect(single.status).toBe(200);
      expect((single.body as { metadata: unknown }).metadata).toBeNull();
    });

    it('echoes the credentials to their own author and leaves them out of the listing', async () => {
      // Classifying a column as a secret obliges a check for where the value is
      // echoed (ADR 0015's third consequence). Both echoes are asserted here
      // rather than argued, because they now say opposite things about the same
      // bytes: `GET /backups/:id` returns the decrypted blob to a caller with
      // `backup:read` on the backed-up Service — the one echo the
      // classification permits, since these are the operator's own stack
      // credentials and there is no other way to see what a schedule will run
      // as — while `GET /backups` projects the column out entirely
      // (`BackupListItem` is `Omit<Backup, 'metadata'>`, `listByService` passes
      // `columns: { metadata: false }`).
      //
      // The two other readers of the row take nothing from this blob, checked
      // by hand: `notifyRun` dispatches `databaseType`, `databaseName`, status
      // and the error message, and `assertStoredValuesShellSafe` names the
      // failing *field* and deliberately never repeats its value.
      const { cookie, stack, destination } = await setUp();

      const created = await request(server)
        .post('/backups')
        .set('Cookie', cookie)
        .send({
          schedule: '0 3 * * *',
          prefix: 'daily',
          database: 'shop',
          databaseType: 'mysql',
          backupType: 'compose',
          serviceId: stack.composeId,
          serviceName: 'db',
          metadata: STACK_CREDENTIALS,
          destinationId: destination.destinationId,
        });
      expect(created.status).toBe(201);
      const { backupId } = created.body as { backupId: string };

      const single = await request(server)
        .get(`/backups/${backupId}`)
        .set('Cookie', cookie);
      expect(single.status).toBe(200);
      expect((single.body as { metadata: unknown }).metadata).toEqual(
        STACK_CREDENTIALS,
      );

      const listed = await request(server)
        .get('/backups')
        .query({ serviceId: stack.composeId, serviceType: 'compose' })
        .set('Cookie', cookie);
      expect(listed.status).toBe(200);
      const rows = listed.body as { backupId: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toHaveProperty('metadata');
      // And not as ciphertext either, which is the way a projection could
      // regress unnoticed now that the column is `text`.
      expect(JSON.stringify(rows)).not.toContain('enc:v1:');
    });
  });

  describe('0066 over a database that predates it', () => {
    let legacy: LegacyDatabase;
    let columnType: string;
    let atRestBeforeMigration: string;
    let atRestAfterMigration: string;
    let readThroughTheColumn: unknown;
    let atRestAfterAWrite: string | null;
    let legacyNullSurvived: unknown;

    const rawMetadata = async (backupId: string): Promise<string | null> => {
      const { rows } = await legacy.pool.query<{ metadata: string | null }>(
        'select metadata::text as metadata from backup where backup_id = $1',
        [backupId],
      );
      return rows[0].metadata;
    };

    beforeAll(async () => {
      legacy = await startLegacyDatabase('i351', MIGRATION_BEFORE);

      // `backup.destination_id` is `NOT NULL` and `backup_parent_matches_type`
      // requires exactly one parent, so a compose backup needs the whole chain
      // down to an organization. `patch/parent-id-constraint.e2e-spec.ts` is
      // the shape this follows.
      await legacy.pool.query(`
        insert into "user" (id, email, updated_at)
          values ('user-1', 'grace@example.com', now());
        insert into organization (id, name, created_at, owner_id)
          values ('org-1', 'Acme', now(), 'user-1');
        insert into project (project_id, name, created_at, organization_id)
          values ('project-1', 'cloudgate', '2026-01-01T00:00:00.000Z', 'org-1');
        insert into environment (environment_id, name, created_at, project_id)
          values ('env-1', 'production', '2026-01-01T00:00:00.000Z', 'project-1');
        insert into compose (compose_id, name, app_name, created_at, environment_id)
          values ('stack-1', 'Shop Stack', 'shop-stack', '2026-01-01T00:00:00.000Z', 'env-1');
        insert into postgres (
          postgres_id, name, app_name, database_name, database_user,
          database_password, created_at, environment_id
        ) values (
          'pg-1', 'Main DB', 'main-db', 'shop', 'shop_user',
          'sup3rS3cret', '2026-01-01T00:00:00.000Z', 'env-1'
        );
        insert into destination (
          destination_id, name, access_key, secret_access_key, bucket, region,
          endpoint, created_at, organization_id
        ) values (
          'dest-1', 'prod-backups', 'AKIAEXAMPLEACCESSKEY', 'sekrit',
          'cloudgate-backups', 'auto', 'https://example.r2.cloudflarestorage.com',
          '2026-01-01T00:00:00.000Z', 'org-1'
        );
      `);

      await legacy.pool.query(
        `insert into backup (
           backup_id, app_name, schedule, database, prefix, service_name,
           destination_id, backup_type, database_type, compose_id, metadata,
           created_at
         ) values (
           'backup-compose', 'backup-legacy1', '0 3 * * *', 'shop', 'daily', 'db',
           'dest-1', 'compose', 'mysql', 'stack-1', $1::jsonb,
           '2026-01-01T00:00:00.000Z'
         )`,
        [JSON.stringify(STACK_CREDENTIALS)],
      );
      // A database backup beside it, because the conversion has to leave the
      // `null` rows readable too and they are the majority of the table.
      await legacy.pool.query(`
        insert into backup (
          backup_id, app_name, schedule, database, prefix, destination_id,
          backup_type, database_type, postgres_id, created_at
        ) values (
          'backup-engine', 'backup-legacy2', '0 4 * * *', 'shop', 'engine',
          'dest-1', 'database', 'postgres', 'pg-1', '2026-01-01T00:00:00.000Z'
        );
      `);

      // The premise, asserted before the migration runs: a `jsonb` column
      // holding all three passwords in cleartext. Without this the whole
      // describe would pass against a migration that did nothing.
      const before = await legacy.pool.query<{ data_type: string }>(
        `select data_type from information_schema.columns
          where table_name = 'backup' and column_name = 'metadata'`,
      );
      expect(before.rows[0].data_type).toBe('jsonb');
      atRestBeforeMigration = (await rawMetadata('backup-compose')) ?? '';

      // `0066`, through the migrator that runs it in production.
      await legacy.migrateToHead();

      const after = await legacy.pool.query<{ data_type: string }>(
        `select data_type from information_schema.columns
          where table_name = 'backup' and column_name = 'metadata'`,
      );
      columnType = after.rows[0].data_type;
      atRestAfterMigration = (await rawMetadata('backup-compose')) ?? '';

      // The pass-through, through the real column rather than a hand-rolled
      // parse: a drizzle instance over the migrated database, with the same
      // schema `src` uses.
      const db = drizzle(legacy.pool, { schema });
      const rows = await db.select().from(schema.backup);
      const byId = new Map(rows.map((row) => [row.backupId, row.metadata]));
      readThroughTheColumn = byId.get('backup-compose');
      legacyNullSurvived = byId.get('backup-engine');

      // And one write, which is the only thing that turns a legacy row into
      // ciphertext.
      await db
        .update(schema.backup)
        .set({ metadata: STACK_CREDENTIALS })
        .where(eq(schema.backup.backupId, 'backup-compose'));
      atRestAfterAWrite = await rawMetadata('backup-compose');
    }, 240_000);

    afterAll(async () => {
      await legacy?.drop();
    });

    it('converts metadata to text', () => {
      // `0066` is exactly what `drizzle-kit generate` emitted — a bare
      // `SET DATA TYPE text` — which is a correction to what `0065` and
      // ADR 0006 used to say about this conversion. Both claimed Postgres
      // refuses that form on a `jsonb` column and that a `USING …::text` is
      // required; it does not, and both now carry the measurement instead.
      // There is no `jsonb`→`text` entry in `pg_cast` at all — Postgres
      // reaches a string-category target through the source type's output
      // function — so the bare statement succeeds and renders the same bytes
      // `::text` would. `0066`'s own comment carries the check that
      // established it. This assertion is what says the
      // statement *runs*: `migrateToHead` above would have thrown otherwise,
      // and a migration that was silently a no-op leaves this `jsonb`.
      expect(columnType).toBe('text');
    });

    it('leaves a legacy row in cleartext, and reads it anyway', () => {
      // The at-rest change could not ship a data migration and no migration can be one: the
      // key is `HMAC-SHA256(APP_ENCRYPTION_SECRET, …)` derived in the Node
      // process, `db:migrate` replays `.sql` and nothing else, and this
      // database has no `pgcrypto`. AES-256-GCM is not expressible there.
      //
      // What makes that safe is ADR 0006: `decryptValue` returns a value
      // lacking the `enc:v1:` prefix unchanged, so the converted column reads
      // a legacy row as the object it always was. This is that claim, at the
      // bytes and through the column — and the `jsonb`→`text` conversion has
      // to have preserved the JSON exactly, which `jsonb_out` does whether it
      // is reached implicitly or through an explicit `::text`.
      expect(atRestBeforeMigration).toContain('maria-pw-351');
      expect(atRestAfterMigration.startsWith('enc:v1:')).toBe(false);
      for (const password of PASSWORDS) {
        expect(atRestAfterMigration).toContain(password);
      }
      expect(readThroughTheColumn).toEqual(STACK_CREDENTIALS);
    });

    it('leaves a legacy null row null, through the converted column', () => {
      // The `null` half of the conversion over real data: `ALTER … TYPE text`
      // leaves a `NULL` as `NULL` rather than as the string `"null"`, which is
      // the one way this conversion could have quietly broken every database
      // backup in an install — `JSON.parse('null')` is `null`, but
      // `decryptValue(null)` is a `TypeError`, and the `null` rows are the
      // majority of the table.
      expect(legacyNullSurvived).toBeNull();
    });

    it('turns that row into ciphertext on its next write', () => {
      // The other half of the no-data-migration argument: the residue is
      // bounded to rows nobody touches, because after `0066` every write goes
      // through `toDriver` and no path can produce new cleartext. An operator
      // rotating the stack's database password — the actual remedy for a
      // credential that has been in a `pg_dump` — encrypts the row on the way
      // past.
      for (const password of PASSWORDS) {
        expect(atRestAfterAWrite).not.toContain(password);
      }
      expect(atRestAfterAWrite?.startsWith('enc:v1:')).toBe(true);
    });
  });
});
