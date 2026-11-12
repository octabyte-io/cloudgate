import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import { BackupRunRecorderService } from '../../src/backups/run-recorder.service';
import type {
  BackupRunStartOptions,
  RunRecordParent,
} from '../../src/backups/run-recorder.service';
import type { CronRunMark } from '../../src/cron-services/cron-run.types';
import type {
  BuildableDeploymentParent,
  CreateDeploymentInput,
  DeploymentParent,
} from '../../src/deployment-engine/ports/deployment-recorder';
import { parentColumns } from '../../src/deployment-engine/ports/deployment-recorder';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { parentColumnsOnTheTable } from '../deployments/deployment-parent-columns';

/**
 * The second half of the at-rest change, and ADR-0017's own outstanding item.
 * `BackupRunRecorderService.start` declared its parent as
 * `fk: { backupId } | { volumeBackupId } | { scheduleId }` and spread it into
 * `.values()` — a second spelling of the vocabulary an earlier change had just written as
 * `DeploymentParent`, on the same five columns of the same table. It was not a
 * defect: the arms were exclusive, the field was internal and no DTO reached
 * it. What it was is *unlinked* — a sixth parent kind added to the union would
 * have left this declaration compiling and nothing would have said so, which
 * is exactly how the two-precedence-orders problem that change deleted came about one
 * level up.
 *
 * **So the property is about the two writers together, not about either one.**
 * `deployment` has five parent columns and a deliberately parentless row.
 * `DeploymentsService.create` writes the two buildable ones; this service
 * writes the other three; `parentColumns` is the single place either of them
 * turns a parent into columns. This file asserts that the partition is
 * complete and that the run recorder actually goes through the shared function
 * — because "it uses the same type" is invisible to a suite the moment somebody
 * spreads the tagged object directly and drizzle quietly ignores the tag.
 */

/**
 * **The split since ADR-0034.** A run of a Cron service hangs off the
 * Cron service itself, an `application`, so the run recorder now writes that
 * arm too — marked as a run (`cronRun`), which is what tells it from a Build
 * deployment on the same column — and the engine's `create` still writes it
 * for builds only, with no field to mark a run. The partition is therefore by
 * column *and* mark: the three run-only columns are the recorder's, the
 * compose column is the engine's, and `application_id` is shared, the
 * recorder's rows on it always marked and the engine's never.
 */

/** The run-record kinds, as values a runtime assertion can iterate. */
const RUN_KINDS = [
  'backup',
  'volumeBackup',
  'schedule',
  'application',
] as const;

/**
 * Compile-time exhaustiveness for the list above: if a fourth arm is ever
 * `Extract`ed into {@link RunRecordParent} and not named in `RUN_KINDS`, this
 * declaration stops compiling. A runtime `.length` check could not do it —
 * the list is the only enumeration there is, so a count derived from it is a
 * count of itself.
 */
const _everyRunKindListed: RunRecordParent['kind'] extends (typeof RUN_KINDS)[number]
  ? true
  : never = true;

/** The same, for the two kinds the *build* port claims. */
const BUILD_KINDS = ['application', 'compose'] as const;

const _everyBuildKindListed: BuildableDeploymentParent['kind'] extends (typeof BUILD_KINDS)[number]
  ? true
  : never = true;

/**
 * The engine's input has no field to mark a run: a build can never be
 * written as one. This stops compiling the day `CreateDeploymentInput` gains
 * a `cronRun`.
 */
const _createNeverMarksARun: 'cronRun' extends keyof CreateDeploymentInput
  ? never
  : true = true;

const CRON_RUN: CronRunMark = {
  job: 'report-run-abcd1234',
  image: 'report:latest',
  startedBy: { kind: 'member', userId: 'u-1', name: 'Ida Rhodes' },
};

/** One start per run kind, with a recognizable id per column. */
const runStarts: readonly Pick<BackupRunStartOptions, 'parent' | 'cronRun'>[] =
  [
    { parent: { kind: 'backup', backupId: 'bk-1' } },
    { parent: { kind: 'volumeBackup', volumeBackupId: 'vb-1' } },
    { parent: { kind: 'schedule', scheduleId: 'sch-1' } },
    {
      parent: { kind: 'application', applicationId: 'app-1' },
      cronRun: CRON_RUN,
    },
  ];
const runArms: readonly RunRecordParent[] = runStarts.map(
  (start) => start.parent,
);

const SRC = join(__dirname, '../../src');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('BackupRunRecorderService, on DeploymentParent', () => {
  it('records a run through the shared parentColumns rather than a spread of its own', async () => {
    // The assertion that a *type* change cannot make on its own. Adopting
    // `DeploymentParent` and then spreading `options.parent` straight into
    // `.values()` would put `kind` in the insert — drizzle drops an unknown key
    // without a word, so the row would still be written and every existing
    // backup, volume-backup and schedule suite would still be green, with the
    // one place that turns a parent into columns bypassed. This is what says
    // the shared function is on the path.
    for (const start of runStarts) {
      const { parent } = start;
      const written: Record<string, unknown>[] = [];
      const db = {
        insert: () => ({
          values: (row: Record<string, unknown>) => {
            written.push(row);
            return {
              returning: () =>
                Promise.resolve([
                  { deploymentId: 'dep-1', logPath: '/tmp/dep-1.log' },
                ]),
            };
          },
        }),
      } as unknown as DrizzleDB;
      const remoteExec = {
        execAsync: () => Promise.resolve({ stdout: '', stderr: '' }),
        execAsyncRemote: () => Promise.resolve({ stdout: '', stderr: '' }),
      } as unknown as RemoteExecService;

      await new BackupRunRecorderService(db, remoteExec).start({
        appName: 'backup-abc123',
        serverId: null,
        title: 'Backup',
        description: 'Backup of shop',
        initMessage: 'Initializing backup',
        ...start,
      } as BackupRunStartOptions);

      expect(written).toHaveLength(1);
      const row = written[0];
      expect(row).not.toHaveProperty('kind');
      // Exactly the columns `parentColumns` names for this arm, and no other
      // parent column left over from a previous branch.
      const parentsSet = parentColumnsOnTheTable().filter(
        (name) => row[name] !== undefined,
      );
      expect(parentsSet).toEqual(Object.keys(parentColumns(parent)));
      // A row on the `application` arm is a run only by its mark (ADR-0034),
      // and no other run carries one.
      expect(row.cronRun).toEqual(
        parent.kind === 'application' ? CRON_RUN : null,
      );
    }
  });

  it('writes a row on the application arm only as a run, which the engine never writes', () => {
    // The recorder cannot be handed the `application` arm without a mark:
    // `BackupRunStartOptions` requires one there, and refuses one elsewhere.
    // @ts-expect-error -- a Cron service's run must say it is a run
    const unmarked: BackupRunStartOptions = {
      appName: 'report',
      serverId: null,
      title: 'Run now',
      description: 'Run of report',
      initMessage: 'Run',
      parent: { kind: 'application', applicationId: 'app-1' },
    };
    // @ts-expect-error -- a backup's run is never a Cron service's
    const marked: BackupRunStartOptions = {
      appName: 'backup-abc123',
      serverId: null,
      title: 'Backup',
      description: 'Backup of shop',
      initMessage: 'Backup',
      parent: { kind: 'backup', backupId: 'bk-1' },
      cronRun: CRON_RUN,
    };
    expect([unmarked.parent.kind, marked.parent.kind]).toEqual([
      'application',
      'backup',
    ]);

    // And no writer of a `deployment` row but the recorder names the mark.
    const writers = sourceFiles(SRC).filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /\.insert\(deployment\)/.test(text) && /cronRun\s*:/.test(text);
    });
    expect(writers.map((file) => relative(SRC, file))).toEqual([
      'backups/run-recorder.service.ts',
    ]);
    expect(_createNeverMarksARun).toBe(true);
  });

  it('partitions every parent column between the writers, sharing only application_id, with none left over', () => {
    // The "one vocabulary" property, which is the whole reason to adopt the
    // port's type here rather than keep a compatible one. A sixth parent added
    // to `DeploymentParent` fails this: `parentColumns` will not compile until
    // the arm is handled (`TS2366`), and the new column then belongs to the
    // build port, to this service, or to neither — and the third case has to
    // be argued rather than defaulted into, because a column no writer claims
    // is a column with no type in front of it.
    const runColumns = runArms.flatMap((parent) =>
      Object.keys(parentColumns(parent)),
    );
    const buildColumns = (
      [
        { kind: 'application', applicationId: 'app-1' },
        { kind: 'compose', composeId: 'cmp-1' },
      ] as const satisfies readonly DeploymentParent[]
    ).flatMap((parent) => Object.keys(parentColumns(parent)));

    // The third writer: an Environment network's own Cloud run,
    // recorded by `DeploymentsService.recordEnvironmentNetworkRun` through
    // the same `parentColumns`, never by the engine or this service.
    const networkColumns = Object.keys(
      parentColumns({
        kind: 'environmentNetwork',
        environmentNetworkId: 'net-1',
      }),
    );
    // The fourth: a postgres on RDS's own Cloud run, recorded by
    // `DeploymentsService.recordPostgresCloudRun` the same way.
    const postgresColumns = Object.keys(
      parentColumns({ kind: 'postgres', postgresId: 'pg-1' }),
    );
    // The fifth: a bucket on AWS's, by `recordBucketCloudRun`.
    const bucketColumns = Object.keys(
      parentColumns({ kind: 'bucket', bucketId: 'bkt-1' }),
    );
    // A mysql on RDS's, by `DeploymentsService.recordMysqlCloudRun`.
    const mysqlColumns = Object.keys(
      parentColumns({ kind: 'mysql', mysqlId: 'my-1' }),
    );
    // The sixth: a redis on ElastiCache's, by
    // `DeploymentsService.recordRedisCloudRun`.
    const redisColumns = Object.keys(
      parentColumns({ kind: 'redis', redisId: 'redis-1' }),
    );

    // One shared column, and only one: `application_id`, which the recorder
    // writes for a Cron service's run (marked, see above) and the engine for
    // a build (ADR-0034). Every other column has exactly one writer.
    expect(runColumns.filter((name) => buildColumns.includes(name))).toEqual([
      'applicationId',
    ]);
    expect(
      [
        ...networkColumns,
        ...postgresColumns,
        ...mysqlColumns,
        ...bucketColumns,
        ...redisColumns,
      ].filter(
        (name) => runColumns.includes(name) || buildColumns.includes(name),
      ),
    ).toEqual([]);
    // And together they are every parent column the table declares — derived
    // from the table's own foreign keys, so a sixth one added to `deployment`
    // fails here even before anybody teaches the union about it. A key that
    // qualifies a parent instead (`previewDeploymentId`), or is no
    // parent at all (`heldByPlanId`), is set aside by name in
    // `deployment-parent-columns.ts`, where the claim is argued.
    expect(
      [
        ...new Set([
          ...runColumns,
          ...buildColumns,
          ...networkColumns,
          ...postgresColumns,
          ...mysqlColumns,
          ...bucketColumns,
          ...redisColumns,
        ]),
      ].sort(),
    ).toEqual(parentColumnsOnTheTable().sort());
  });

  it('keeps the two compile-time exhaustiveness pins live', () => {
    // The two `extends` declarations above are erased at runtime, so a reader
    // has no way to tell a live pin from one that was deleted. Naming them
    // here means `noUnusedLocals` cannot be what keeps them, and a deletion is
    // a failing test rather than a silently smaller file.
    expect([_everyRunKindListed, _everyBuildKindListed]).toEqual([true, true]);
    expect([...new Set([...RUN_KINDS, ...BUILD_KINDS])].sort()).toEqual([
      'application',
      'backup',
      'compose',
      'schedule',
      'volumeBackup',
    ]);
  });
});
