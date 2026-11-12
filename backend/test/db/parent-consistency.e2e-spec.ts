import { startLegacyDatabase } from '../utils/migrations-up-to';
import type { LegacyDatabase } from '../utils/migrations-up-to';

/**
 * The five tables an earlier sweep found carrying mutually exclusive parent
 * columns and left alone, constrained in
 * `drizzle/0064_parent-matches-discriminant.sql`.
 *
 * Two shapes, and the difference is what this suite is mostly about:
 *
 * - `deployment` has no discriminant, so its constraint counts keys —
 *   `num_nonnulls(…) <= 1`. **Not the `(application_id IS NULL) <> (compose_id
 *   IS NULL)` that was asked for**, which would have refused every backup,
 *   volume-backup and schedule run record in the product: those rows set one of
 *   the *other three* columns and neither of the two the XOR names. Two of the
 *   cases below exist to hold that finding — a `backup_id`-only record survives
 *   the migration, and a parentless one does too, because `ownerOf` answers 404
 *   for it by name and `run-history.e2e-spec.ts` pins that.
 * - `mount`, `volume_backup`, `schedule` and `backup` each carry a discriminant
 *   already, so theirs says the stronger thing: the column that is set is the
 *   one the discriminant names. "At most one owner" would not have caught the
 *   rows below at all — every one of them sets exactly one *extra* key beside a
 *   correct one, or names a discriminant pointing at a different Service.
 *
 * **Written against the migrator, not against the SQL**, on
 * `patch/parent-id-constraint.e2e-spec.ts`' terms and for its reason: the
 * harness replays every migration into the template database before any test
 * data exists, so `0064` runs there against empty tables and an ordinary suite
 * cannot observe it normalizing anything. `startLegacyDatabase` builds a
 * database whose history stops at `0063` on the server the run already shares.
 *
 * The before-state is asserted rather than assumed: a fixture that never
 * carried a stray key would make every normalization assertion here pass
 * against a migration whose `UPDATE`s do nothing at all.
 */

/** The last migration before the five constraints. */
const MIGRATION_BEFORE_CONSTRAINTS = '0063_exactly-one-parent-id';

/** Row id → the parent columns that are set on it, by SQL column name. */
type ParentsById = Record<string, Record<string, string>>;

describe('Parent consistency (e2e)', () => {
  let legacy: LegacyDatabase;

  const before: Record<string, ParentsById> = {};
  const after: Record<string, ParentsById> = {};

  /**
   * The non-null parent columns of every row of `table`, keyed by id.
   *
   * Read as "which keys are set" rather than as a fixed column list, so an
   * assertion states the *shape* — `{ application_id: 'app-1' }` — and a
   * cleared column is an absent key rather than an explicit `null` repeated
   * across seven columns nobody is asserting about.
   */
  const parentsOf = async (
    table: string,
    idColumn: string,
    columns: readonly string[],
  ): Promise<ParentsById> => {
    const rows = (
      await legacy.pool.query<Record<string, string | null>>(
        `select "${idColumn}" as id, ${columns
          .map((column) => `"${column}"`)
          .join(', ')} from "${table}"`,
      )
    ).rows;
    return Object.fromEntries(
      rows.map((row) => [
        row.id as string,
        Object.fromEntries(
          columns
            .filter((column) => row[column] !== null)
            .map((column) => [column, row[column] as string]),
        ),
      ]),
    );
  };

  const SERVICE_PARENTS = [
    'application_id',
    'compose_id',
    'libsql_id',
    'mariadb_id',
    'mongo_id',
    'mysql_id',
    'postgres_id',
    'redis_id',
  ] as const;

  const readAll = async (): Promise<Record<string, ParentsById>> => ({
    mount: await parentsOf('mount', 'mount_id', SERVICE_PARENTS),
    volume_backup: await parentsOf(
      'volume_backup',
      'volume_backup_id',
      SERVICE_PARENTS,
    ),
    schedule: await parentsOf('schedule', 'schedule_id', [
      'application_id',
      'compose_id',
      'server_id',
      'organization_id',
    ]),
    backup: await parentsOf('backup', 'backup_id', [
      'compose_id',
      'postgres_id',
      'mariadb_id',
      'mysql_id',
      'mongo_id',
      'libsql_id',
    ]),
    deployment: await parentsOf('deployment', 'deployment_id', [
      'application_id',
      'compose_id',
      'backup_id',
      'volume_backup_id',
      'schedule_id',
    ]),
  });

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
    legacy = await startLegacyDatabase('i328', MIGRATION_BEFORE_CONSTRAINTS);

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
      insert into postgres (
        postgres_id, name, app_name, database_name, database_user,
        database_password, created_at, environment_id
      ) values ('pg-1', 'Orders', 'orders-pg', 'orders', 'orders', 'x',
                '2026-01-01T00:00:00.000Z', 'env-1');
      insert into redis (
        redis_id, name, app_name, database_password, created_at, environment_id
      ) values ('redis-1', 'Cache', 'cache-redis', 'x',
                '2026-01-01T00:00:00.000Z', 'env-1');
      insert into server (
        server_id, name, ip_address, port, created_at, organization_id
      ) values ('server-1', 'eu-1', '203.0.113.7', 22,
                '2026-01-01T00:00:00.000Z', 'org-1');
      insert into destination (
        destination_id, name, access_key, secret_access_key, bucket, region,
        endpoint, created_at, organization_id
      ) values ('dest-1', 'prod', 'AKIA', 'secret', 'cg', 'auto',
                'https://s3.example.com', '2026-01-01T00:00:00.000Z', 'org-1');
    `);

    // The rows a `CHECK` has to be able to survive being added over. Each
    // "-stray" row is a correct discriminant and a correct key with **one extra
    // key beside it** — the shape a hand-run `UPDATE` leaves and the only one
    // 0064 can repair, since the discriminant still names a parent that is
    // there. Each "-ok" row is the normal shape, and is here because an
    // `UPDATE` missing its `WHERE` would detach every one of them.
    await legacy.pool.query(`
      insert into mount (mount_id, type, mount_path, service_type, application_id, redis_id)
        values ('mount-stray', 'volume', '/data', 'application', 'app-1', 'redis-1');
      insert into mount (mount_id, type, mount_path, service_type, postgres_id)
        values ('mount-ok', 'volume', '/var/lib/postgresql/data', 'postgres', 'pg-1');

      insert into volume_backup (
        volume_backup_id, name, volume_name, prefix, service_type, app_name,
        schedule, destination_id, created_at, compose_id, application_id
      ) values ('vb-stray', 'edge data', 'edge-data', 'edge/', 'compose',
                'volume-backup-aaaaaa', '0 2 * * *', 'dest-1',
                '2026-01-01T00:00:00.000Z', 'stack-1', 'app-1');
      insert into volume_backup (
        volume_backup_id, name, volume_name, prefix, service_type, app_name,
        schedule, destination_id, created_at, application_id
      ) values ('vb-ok', 'shop data', 'shop-data', 'shop/', 'application',
                'volume-backup-bbbbbb', '0 3 * * *', 'dest-1',
                '2026-01-01T00:00:00.000Z', 'app-1');

      insert into schedule (
        schedule_id, name, cron_expression, app_name, schedule_type, command,
        created_at, server_id, organization_id
      ) values ('sched-stray', 'prune the host', '0 4 * * *', 'schedule-aaaaaa',
                'server', 'docker system prune -f', '2026-01-01T00:00:00.000Z',
                'server-1', 'org-1');
      insert into schedule (
        schedule_id, name, cron_expression, app_name, schedule_type, command,
        created_at, application_id
      ) values ('sched-ok', 'trim sessions', '0 3 * * *', 'schedule-bbbbbb',
                'application', 'rails db:sessions:trim',
                '2026-01-01T00:00:00.000Z', 'app-1');

      insert into backup (
        backup_id, app_name, schedule, database, prefix, destination_id,
        backup_type, database_type, created_at, compose_id, postgres_id
      ) values ('backup-stray', 'backup-aaaaaa', '0 1 * * *', 'orders', 'orders/',
                'dest-1', 'compose', 'postgres', '2026-01-01T00:00:00.000Z',
                'stack-1', 'pg-1');
      insert into backup (
        backup_id, app_name, schedule, database, prefix, destination_id,
        backup_type, database_type, created_at, postgres_id
      ) values ('backup-ok', 'backup-bbbbbb', '0 2 * * *', 'orders', 'orders/',
                'dest-1', 'database', 'postgres', '2026-01-01T00:00:00.000Z',
                'pg-1');

      insert into deployment (deployment_id, title, log_path, created_at,
                              application_id, compose_id, schedule_id)
        values ('deploy-stray', 'Manual deployment', '/logs/a.log',
                '2026-01-01T00:00:00.000Z', 'app-1', 'stack-1', 'sched-ok');
      insert into deployment (deployment_id, title, log_path, created_at, application_id)
        values ('deploy-ok', 'Manual deployment', '/logs/b.log',
                '2026-01-01T00:00:00.000Z', 'app-1');
      insert into deployment (deployment_id, title, log_path, created_at, backup_id)
        values ('deploy-run', 'Backup', '/logs/c.log',
                '2026-01-01T00:00:00.000Z', 'backup-ok');
      insert into deployment (deployment_id, title, log_path, created_at)
        values ('deploy-orphan', 'Schedule', '/logs/d.log',
                '2026-01-01T00:00:00.000Z');
    `);

    Object.assign(before, await readAll());
    // The constraints, through the migrator that applies them in production.
    await legacy.migrateToHead();
    Object.assign(after, await readAll());
  }, 180_000);

  afterAll(async () => {
    await legacy?.drop();
  });

  it('stores a row disagreeing with its discriminant on a history that stops before the constraints', () => {
    // The before state. Without it every normalization assertion below is
    // green against a migration that only ran the five ALTERs.
    expect({
      mount: before.mount['mount-stray'],
      volumeBackup: before.volume_backup['vb-stray'],
      schedule: before.schedule['sched-stray'],
      backup: before.backup['backup-stray'],
      deployment: before.deployment['deploy-stray'],
    }).toEqual({
      mount: { application_id: 'app-1', redis_id: 'redis-1' },
      volumeBackup: { compose_id: 'stack-1', application_id: 'app-1' },
      schedule: { server_id: 'server-1', organization_id: 'org-1' },
      backup: { compose_id: 'stack-1', postgres_id: 'pg-1' },
      deployment: {
        application_id: 'app-1',
        compose_id: 'stack-1',
        schedule_id: 'sched-ok',
      },
    });
  });

  it("clears every key the row's own discriminant does not name, and keeps the one it does", () => {
    // Not deleted, and the discriminant's own key is not the one cleared: the
    // row goes on being the mount, volume backup, cron job or dump that
    // `serviceIdOf` has always read it as, and stops appearing in a
    // `listByService` for a Service that never authorized it — and stops being
    // cascade-deleted by that Service.
    expect({
      mount: after.mount['mount-stray'],
      volumeBackup: after.volume_backup['vb-stray'],
      schedule: after.schedule['sched-stray'],
      backup: after.backup['backup-stray'],
    }).toEqual({
      mount: { application_id: 'app-1' },
      volumeBackup: { compose_id: 'stack-1' },
      schedule: { server_id: 'server-1' },
      backup: { compose_id: 'stack-1' },
    });
  });

  it('narrows a multi-owner deployment record to the owner its feeds already titled it by', () => {
    // `service-scope.ts`' `ownerOf` tests applicationId first, so the record
    // has always been displayed as the Application build it now solely is.
    expect(after.deployment['deploy-stray']).toEqual({
      application_id: 'app-1',
    });
  });

  it('leaves every already-consistent row exactly as it was', () => {
    // The five `UPDATE`s are keyed to rows that carry more than one key. One
    // missing that predicate would detach every mount, volume backup, schedule
    // and backup on the instance whose discriminant happens to be defaulted.
    expect({
      mount: after.mount['mount-ok'],
      volumeBackup: after.volume_backup['vb-ok'],
      schedule: after.schedule['sched-ok'],
      backup: after.backup['backup-ok'],
      deployment: after.deployment['deploy-ok'],
    }).toEqual({
      mount: before.mount['mount-ok'],
      volumeBackup: before.volume_backup['vb-ok'],
      schedule: before.schedule['sched-ok'],
      backup: before.backup['backup-ok'],
      deployment: before.deployment['deploy-ok'],
    });
  });

  it('keeps the two deployment records the proposed XOR would have destroyed', () => {
    // The finding, as data. `(application_id IS NULL) <> (compose_id IS NULL)`
    // is false for both of these — a backup/volume-backup/schedule run record
    // sets neither column — so it would have aborted the migration on the first
    // install that had ever run a backup, and refused every one written after.
    expect({
      run: after.deployment['deploy-run'],
      orphan: after.deployment['deploy-orphan'],
    }).toEqual({
      run: { backup_id: 'backup-ok' },
      orphan: {},
    });
  });

  it('refuses a new row whose set key is not the one its discriminant names', async () => {
    // The rule as a database fact, and the half a service-layer sweep cannot
    // reach: a migration, a fixture or a hand-run UPDATE is outside
    // `test/coding-standards/parent-id-writes.spec.ts` entirely.
    const refusals = {
      mount: await refusal(
        `insert into mount (mount_id, type, mount_path, service_type, postgres_id)
           values ('mount-wrong', 'volume', '/data', 'application', 'pg-1')`,
      ),
      volumeBackup: await refusal(
        `insert into volume_backup (
           volume_backup_id, name, volume_name, prefix, service_type, app_name,
           schedule, destination_id, created_at, application_id
         ) values ('vb-wrong', 'x', 'v', 'p/', 'compose', 'volume-backup-cccccc',
                   '0 2 * * *', 'dest-1', '2026-02-01T00:00:00.000Z', 'app-1')`,
      ),
      schedule: await refusal(
        `insert into schedule (
           schedule_id, name, cron_expression, app_name, schedule_type, command,
           created_at, server_id
         ) values ('sched-wrong', 'x', '0 4 * * *', 'schedule-cccccc',
                   'cloudgate-server', '', '2026-02-01T00:00:00.000Z', 'server-1')`,
      ),
      backup: await refusal(
        `insert into backup (
           backup_id, app_name, schedule, database, prefix, destination_id,
           backup_type, database_type, created_at, compose_id
         ) values ('backup-wrong', 'backup-cccccc', '0 1 * * *', 'orders', 'o/',
                   'dest-1', 'database', 'postgres', '2026-02-01T00:00:00.000Z',
                   'stack-1')`,
      ),
    };

    expect(refusals.mount).toContain('mount_parent_matches_service_type');
    expect(refusals.volumeBackup).toContain(
      'volume_backup_parent_matches_service_type',
    );
    expect(refusals.schedule).toContain(
      'schedule_parent_matches_schedule_type',
    );
    expect(refusals.backup).toContain('backup_parent_matches_type');
  });

  it('refuses a new row carrying a second owner, on all five tables', async () => {
    const refusals = {
      mount: await refusal(
        `insert into mount (mount_id, type, mount_path, service_type, application_id, redis_id)
           values ('mount-two', 'volume', '/data', 'application', 'app-1', 'redis-1')`,
      ),
      volumeBackup: await refusal(
        `insert into volume_backup (
           volume_backup_id, name, volume_name, prefix, service_type, app_name,
           schedule, destination_id, created_at, application_id, redis_id
         ) values ('vb-two', 'x', 'v', 'p/', 'application', 'volume-backup-dddddd',
                   '0 2 * * *', 'dest-1', '2026-02-01T00:00:00.000Z', 'app-1', 'redis-1')`,
      ),
      schedule: await refusal(
        `insert into schedule (
           schedule_id, name, cron_expression, app_name, schedule_type, command,
           created_at, application_id, organization_id
         ) values ('sched-two', 'x', '0 4 * * *', 'schedule-dddddd', 'application',
                   'echo', '2026-02-01T00:00:00.000Z', 'app-1', 'org-1')`,
      ),
      backup: await refusal(
        // The discriminant pair names `compose_id` and `compose_id` is set, so
        // this row is refused by the `num_nonnulls` half alone — the half a
        // pure consistency `CASE` would have missed.
        `insert into backup (
           backup_id, app_name, schedule, database, prefix, destination_id,
           backup_type, database_type, created_at, compose_id, postgres_id
         ) values ('backup-two', 'backup-dddddd', '0 1 * * *', 'orders', 'o/',
                   'dest-1', 'compose', 'postgres', '2026-02-01T00:00:00.000Z',
                   'stack-1', 'pg-1')`,
      ),
      deployment: await refusal(
        `insert into deployment (deployment_id, title, log_path, created_at,
                                 application_id, backup_id)
           values ('deploy-two', 'x', '/logs/e.log', '2026-02-01T00:00:00.000Z',
                   'app-1', 'backup-ok')`,
      ),
    };

    expect(refusals.mount).toContain('mount_parent_matches_service_type');
    expect(refusals.volumeBackup).toContain(
      'volume_backup_parent_matches_service_type',
    );
    expect(refusals.schedule).toContain(
      'schedule_parent_matches_schedule_type',
    );
    expect(refusals.backup).toContain('backup_parent_matches_type');
    expect(refusals.deployment).toContain('deployment_at_most_one_parent');
  });

  it('refuses an update that would give an existing row a second owner', async () => {
    // The direction no DTO covers: every update schema in the four modules
    // omits the parent columns, so the wire cannot re-point a row — but an
    // internal writer or a `psql` session could, and from here neither can.
    const refusals = {
      mount: await refusal(
        `update mount set redis_id = 'redis-1' where mount_id = 'mount-ok'`,
      ),
      schedule: await refusal(
        `update schedule set organization_id = 'org-1' where schedule_id = 'sched-ok'`,
      ),
      deployment: await refusal(
        `update deployment set compose_id = 'stack-1' where deployment_id = 'deploy-ok'`,
      ),
    };

    expect(refusals.mount).toContain('mount_parent_matches_service_type');
    expect(refusals.schedule).toContain(
      'schedule_parent_matches_schedule_type',
    );
    expect(refusals.deployment).toContain('deployment_at_most_one_parent');
  });

  it('refuses a mount or a schedule that owns nothing, and still accepts a deployment record that does', async () => {
    // The one place the five constraints deliberately disagree. The four
    // discriminated tables have no reader for an ownerless row —
    // `serviceIdOf` throws `NotFoundException('… has no owning service')` —
    // and no path in the tree writes one, so `= 1` costs no install a row.
    // `deployment` does have such a reader, `ownerOf`'s
    // `NotFoundException('Deployment not found')`, reached by a row
    // `run-history.e2e-spec.ts` inserts by hand; `<= 1` is what keeps it
    // writable.
    const results = {
      mount: await refusal(
        `insert into mount (mount_id, type, mount_path, service_type)
           values ('mount-none', 'volume', '/data', 'application')`,
      ),
      schedule: await refusal(
        `insert into schedule (schedule_id, name, cron_expression, app_name,
                               schedule_type, command, created_at)
           values ('sched-none', 'x', '0 4 * * *', 'schedule-eeeeee',
                   'application', 'echo', '2026-02-01T00:00:00.000Z')`,
      ),
      deployment: await refusal(
        `insert into deployment (deployment_id, title, log_path, created_at)
           values ('deploy-none', 'Schedule', '/logs/f.log', '2026-02-01T00:00:00.000Z')`,
      ),
    };

    expect(results.mount).toContain('mount_parent_matches_service_type');
    expect(results.schedule).toContain('schedule_parent_matches_schedule_type');
    expect(results.deployment).toBeNull();
  });

  it('still accepts every row shape the product writes', async () => {
    // The positive control. A constraint that refused everything would satisfy
    // every assertion above and break `POST /mounts`, `POST /volume-backups`,
    // `POST /schedules`, `POST /backups` and every deploy outright. One entry
    // per writer: `MountsService.insertMount`, `VolumeBackupsService.create`,
    // both halves of `SchedulesService.create`'s four-way spread,
    // `BackupsService.create`'s compose branch, `DeploymentsService.deploy` and
    // `BackupRunRecorderService.start`'s three run-record arms of
    // `DeploymentParent` (`RunRecordParent`,).
    const accepted = {
      mount: await refusal(
        `insert into mount (mount_id, type, mount_path, service_type, redis_id)
           values ('mount-new', 'volume', '/data', 'redis', 'redis-1')`,
      ),
      volumeBackup: await refusal(
        `insert into volume_backup (
           volume_backup_id, name, volume_name, prefix, service_type, app_name,
           schedule, destination_id, created_at, compose_id
         ) values ('vb-new', 'x', 'v', 'p/', 'compose', 'volume-backup-eeeeee',
                   '0 2 * * *', 'dest-1', '2026-02-01T00:00:00.000Z', 'stack-1')`,
      ),
      scheduleOnServer: await refusal(
        `insert into schedule (schedule_id, name, cron_expression, app_name,
                               schedule_type, command, created_at, server_id)
           values ('sched-new-server', 'x', '0 4 * * *', 'schedule-ffffff',
                   'server', 'echo', '2026-02-01T00:00:00.000Z', 'server-1')`,
      ),
      scheduleOnHost: await refusal(
        `insert into schedule (schedule_id, name, cron_expression, app_name,
                               schedule_type, command, created_at, organization_id)
           values ('sched-new-host', 'x', '0 4 * * *', 'schedule-gggggg',
                   'cloudgate-server', 'echo', '2026-02-01T00:00:00.000Z', 'org-1')`,
      ),
      backupOnCompose: await refusal(
        `insert into backup (
           backup_id, app_name, schedule, database, prefix, destination_id,
           backup_type, database_type, created_at, compose_id
         ) values ('backup-new', 'backup-eeeeee', '0 1 * * *', 'orders', 'o/',
                   'dest-1', 'compose', 'postgres', '2026-02-01T00:00:00.000Z',
                   'stack-1')`,
      ),
      deploymentOfCompose: await refusal(
        `insert into deployment (deployment_id, title, log_path, created_at, compose_id)
           values ('deploy-new', 'Manual deployment', '/logs/g.log',
                   '2026-02-01T00:00:00.000Z', 'stack-1')`,
      ),
      deploymentOfVolumeBackupRun: await refusal(
        `insert into deployment (deployment_id, title, log_path, created_at, volume_backup_id)
           values ('deploy-vb-run', 'Volume Backup', '/logs/h.log',
                   '2026-02-01T00:00:00.000Z', 'vb-ok')`,
      ),
      deploymentOfScheduleRun: await refusal(
        `insert into deployment (deployment_id, title, log_path, created_at, schedule_id)
           values ('deploy-sched-run', 'Schedule', '/logs/i.log',
                   '2026-02-01T00:00:00.000Z', 'sched-ok')`,
      ),
    };

    expect(accepted).toEqual({
      mount: null,
      volumeBackup: null,
      scheduleOnServer: null,
      scheduleOnHost: null,
      backupOnCompose: null,
      deploymentOfCompose: null,
      deploymentOfVolumeBackupRun: null,
      deploymentOfScheduleRun: null,
    });
  });
});
