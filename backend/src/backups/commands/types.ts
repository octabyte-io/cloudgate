/** The engines a backup can dump — databaseTypeEnum minus 'web-server',
 * which is reserved for a backup of the instance itself and needs web-server
 * settings. */
export type BackupDatabaseType =
  'postgres' | 'mysql' | 'mariadb' | 'mongo' | 'libsql';

/** The credential fields a dump/restore command is parameterized by. Which
 * ones matter depends on the engine (mysql wants the root password as
 * databasePassword; libsql wants none).
 *
 * The optional two reach `quote()` as `?? ''` (H-37). An absent value used to
 * interpolate as the literal string `undefined`, which is not a credential
 * anyone has and made the engine's own refusal the diagnosis; an empty word is
 * the same refusal with a truthful command behind it. Neither is reachable
 * from a builder that needs the field — the engines that read them are the
 * engines whose rows carry them — so this is a shape, not a behaviour. */
export interface DatabaseCredentials {
  database: string;
  databaseUser?: string;
  databasePassword?: string;
}

/**
 * A command and the environment it needs to authenticate — never the same
 * thing (ADR 0015).
 *
 * The engines used to hand back a string with the password in it:
 * `mysqldump … --password=<the root password>`, `mariadb -p<the password>`,
 * `mongodump -p <the password>`. That string is what `ExecError` captures and
 * what pino's error serializer then writes six times over — `message`, `stack`,
 * `command`, `originalError.message`, `originalError.stack`, `cmd` — plus a
 * seventh as pino's `msg`. It is also what `BackupsService.notifyRun` builds a
 * notification body from and what a Server's process table shows while the dump
 * runs. The same value was already `encryptedJson` in `backup.metadata`, so
 * the platform called it a secret at rest and printed it in clear on failure.
 *
 * **The fix is never-carry, not a fourth elision pattern**, which ADR 0015's
 * last bullet says in as many words: a value that never enters a command string
 * cannot be journalled, mis-elided or picked up by the next tool that reads the
 * string, while a mask has to keep being right. The pair is what makes that
 * expressible — the builder says what it needs and where, and the value travels
 * in {@link RemoteExecOptions.env}, which is the seam `execRclone` already
 * carries the S3 credentials over for the same reason.
 *
 * A pair rather than a builder that reaches for an env itself, because the
 * builders are pure and the environment belongs to the *execution*: only
 * `BackupsService` knows which `execRclone` call this command is for.
 */
export interface EngineCommand {
  /** The `docker exec …` command. Carries no credential, by construction. */
  command: string;
  /**
   * Variables {@link command} reads, to be merged into the environment it is
   * executed with. Empty for an engine that authenticates some other way —
   * postgres over the container's local socket, libsql not at all.
   */
  env: Record<string, string>;
}

/**
 * One backup-command builder per engine: its dump and its restore. Both
 * commands run inside `$CONTAINER_ID`, resolved by the container-search helpers
 * before the pipeline runs.
 */
export interface BackupCommandBuilder {
  /** Dump file extension the S3 object name ends with. */
  extension: 'sql.gz' | 'bson.gz' | 'tar.gz';
  /** The dump-and-compress pipeline, streamed to stdout for rclone rcat. */
  dump(credentials: DatabaseCredentials): EngineCommand;
  /** The import command, reading the (decompressed) dump from stdin. */
  restore(credentials: DatabaseCredentials): EngineCommand;
}
