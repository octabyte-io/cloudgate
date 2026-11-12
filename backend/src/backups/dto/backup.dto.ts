import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { cronExpressionSchema } from '../../common/cron-expression';
import {
  COMPOSE_SERVICE_NAME_MESSAGE,
  COMPOSE_SERVICE_NAME_REGEX,
  S3_KEY_MESSAGE,
  S3_KEY_REGEX,
} from '../../volume-backups/dto/volume-backup.dto';
import { backupServiceTypes } from '../backup.schema';
import {
  BUCKET_TRAVERSAL_MESSAGE,
  hasTraversalSegment,
  normalizeS3Path,
} from '../commands/utils';

// Create/update input. The owning service is named by serviceId +
// backupType/databaseType rather than one FK field per engine (the mounts
// precedent): a database backup's serviceId is the engine row, a compose
// backup's is the compose stack.

/** The engines a backup can target — database_type minus 'web-server'. */
export const backupDatabaseTypes = [
  'postgres',
  'mysql',
  'mariadb',
  'mongo',
  'libsql',
] as const;

/**
 * The bucket path a Service's dumps live under — `S3_KEY_REGEX`, the same rule
 * `createVolumeBackupSchema.prefix` has carried since it was written, applied
 * to the path the value denotes rather than to the value.
 *
 * **What was wrong.** This field was `z.string().min(1)` and nothing else,
 * while the identical field one module over carried a charset. It is the
 * middle segment of every dump's key — `BackupsService.buildRunScript` builds
 * `{appName}/{prefix}/{timestamp}.{ext}` and hands it to `rclone rcat`, and
 * `pruneOldBackups` takes the same path into an `rclone lsf` and an
 * `rclone delete`. It was given `bucketKeySegments`' refusal of a `.`/`..`
 * segment on `create` and `update`, which is about *traversal* and says
 * nothing about the rest of the character set.
 *
 * **Imported rather than re-declared**, on this file's own precedent with
 * `COMPOSE_SERVICE_NAME_REGEX` (§1.4): a volume backup's `prefix` and a
 * database backup's `prefix` are the same string in the same bucket, reaching
 * the same rclone words through the same `normalizeS3Path`, and
 * {@link S3_KEY_REGEX}'s docblock carries the argument — including why the
 * leading-alphanumeric anchor is there.
 *
 * **Held over `normalizeS3Path(prefix)`, and that is the whole of what makes
 * this rule safe to add to a module with older rows.** The sibling applies the
 * same regex to the raw string, and it can: its charset has been there since
 * its first row. Here the rows came first, and `normalizeS3Path` — which
 * `.trim()`s and strips leading and trailing `/` — is what every one of the
 * three readers of this column calls before building a word from it
 * (`buildRunScript`, `pruneOldBackups`, `listBackupFiles`). So `/daily`,
 * `daily/` and ` /daily/ ` are one path, `daily/`, and they are all reachable
 * rows. **The slashes are what the console itself admits to**: its form schema
 * trims both this field and `database`, so padding is not what it sends — but
 * it has never stripped a slash, and `backup-schedule-spec.tsx` renders a
 * stored prefix as `row.prefix.replace(/^\/+/, "")`, which is that file saying
 * out loud that slashed rows are out there. **The padding is reachable the
 * other way**: `BackupsService.create` and `update` are the only writers of
 * this column, this DTO is their whole boundary, and it has never trimmed — so
 * any client that is not this console could store one, and no write will ever
 * revisit the row. Validating the raw string would have refused every one of
 * those runs, through the guard below, for a prefix that resolves to exactly
 * the key it always did — H-21's failure mode inverted, a guard that stops the
 * backups it was added to protect.
 *
 * Validating the denoted path is also the *stronger* claim, not a concession:
 * the string this checks is the string that reaches the shell, so a `\n` or a
 * trailing space cannot pass here and appear in a word later. What is refused
 * is unchanged for everything that matters — `a;rm -rf /`, `a$(id)`, `a b`, a
 * leading `-` — because `normalizeS3Path` touches none of those characters.
 *
 * **What happens to a row outside it.** `min(1)` already said a schedule needs
 * a prefix; this says the same about the path, so a prefix of `/` or `"   "`
 * — which denote no path and would write the dump straight under `{appName}/`
 * — is refused where it used to pass. Nothing else that a run could execute
 * becomes legal. A row outside the rule fails its next run loudly through
 * {@link storedBackupShellSchema} rather than silently: see
 * {@link DATABASE_NAME_REGEX} for that argument in full, which is the same
 * one.
 *
 * **The segment rule still stands beside it and is not folded in.** A key like
 * `a/../b` satisfies this charset, so `bucketKeySegments` keeps its throw on
 * `create` and `update` and {@link storedBackupShellSchema} keeps its
 * refinement. The charset is the wider bound; the segment rule is the one
 * about who owns the prefix.
 *
 * **The cost, since it is a stated value that the document
 * carries a charset:** a `.refine` is opaque to the OpenAPI generator, so
 * `openapi.json` shows this field as `minLength: 1` where `database` beside it
 * shows its `pattern`. Restating {@link S3_KEY_REGEX} as a second, padding-
 * tolerant regex would buy that line back and cost the property §2.4 is about
 * — one rule, one spelling, and no chance of the two drifting. The refusal
 * still names the rule to the caller: `S3_KEY_MESSAGE` is what a 400 says.
 */
const backupPrefixSchema = z
  .string()
  .min(1)
  .refine((value) => S3_KEY_REGEX.test(normalizeS3Path(value)), S3_KEY_MESSAGE);

/**
 * The characters a database name may carry — the name the five dump tools are
 * pointed at, which is a different string from an S3 key and takes its own
 * rule.
 *
 * **What was wrong.** `database` was `z.string().min(1)` from the phase that
 * wrote this module, and it reaches every engine's dump and restore command
 * through `BackupsService.credentialsFor`. Those words are `quote()`d (H-36,
 * H-37) and `backup-shell-safety.spec.ts` proves it by running them — so a `;`
 * or a `$(…)` in a stored `database` was already data rather than a command.
 * A charset is not standing in for that quoting; it buys the two things
 * quoting cannot.
 *
 * **First: `quote()` does not stop a word being read as a *flag*.**
 * `quote(['--help'])` is `--help`, unchanged, and in three of the five dumps
 * this value is a bare positional argument — `pg_dump … --no-password <db>`,
 * `mysqldump … --quick <db>`, `mariadb-dump … --databases <db>` — as it is in
 * the `mysql` and `mariadb` restores. So `--file=/etc/…` in a stored
 * `database` is an option to the dump tool, not a database name, and the only
 * thing that refuses it is a first character that cannot be a `-`.
 *
 * **Second: on libsql the value is a path on the run host.** That engine has
 * no dump tool, so `libsqlBackupCommands.dump` tars the directory itself —
 * `tar cf - -C /var/lib/sqld <db>` — and a `/` or a leading `..` would climb
 * out of the sqld data directory. Neither `/` nor a leading `.` is in this
 * set, which makes a traversal unspellable rather than refused a second time.
 *
 * **Drawn as wide as those two readings allow, because it refuses rows that
 * already exist.** The set is the union of what the five engines take in an
 * *unquoted* identifier — Postgres's `[A-Za-z_][A-Za-z0-9_$]*`, MySQL's and
 * MariaDB's `[0-9A-Za-z$_]`, Mongo's "anything but `/\. "$*<>:|?`", and for
 * libsql a single directory name under `/var/lib/sqld` — with `.` and `-`
 * added because a real database is called `app-prod`, `shop.v2` or `iku.db`,
 * and with a leading `_` allowed because Postgres's own rule starts there.
 * Nothing is left out for tidiness: `$` is in it precisely because two of the
 * five take it and `quote()` makes it inert, so excluding it would refuse a
 * name that exists and buy nothing. What is excluded is exactly what the two
 * readings above require — `/`, and a leading `-` or `.` — plus whitespace,
 * which is the one character that would split this into two arguments at a
 * sink that forgot to `quote()`, and which no engine takes in a name without
 * quoting it anyway.
 *
 * **What happens to a stored row outside it, stated because it is the reason
 * this took a decision rather than a line.** The console prefills this field
 * from the engine row's own `databaseName` (`backup-schedule-spec.tsx`'s
 * `suggestedDatabase`) and then lets the operator type over it, and that
 * column is `z.string().min(1)` with no charset of its own — so a row outside
 * this set is reachable, unlike `serviceName`, which no console flow
 * could produce. {@link storedBackupShellSchema} is derived from this schema,
 * so the rule lands on stored rows the moment it lands on the route: every run
 * of such a backup, scheduled or manual, is refused by
 * `BackupsService.assertStoredValuesShellSafe` — recorded as an `error`
 * deployment and notified with the field named.
 *
 * That is the loud, fixable outcome, and it is chosen over the two
 * alternatives. Leaving the DTO alone leaves the field with no rule at all and
 * leaves `--file=…` a working option on the dump tool. Normalizing the stored
 * name would point the dump at a *different database* and believe it, which
 * for a backup is the worst of the three (`cleanAppName`'s precedent). The
 * price is bounded by how narrow the exclusions are: a name reaching this rule
 * from a working `pg_dump` has to contain a `/` or a space, or begin with a
 * `-` or a `.`. The operator's repair is a `PATCH /backups/:id` with an in-set
 * name, or deleting the backup; the run that says so names the field.
 *
 * **Not `S3_KEY_REGEX` and not `VOLUME_NAME_REGEX`**, which are the two
 * obvious reuses (§1.4). `S3_KEY_REGEX` admits `/`, the one character that
 * makes libsql's tar word a path into somewhere else; `VOLUME_NAME_REGEX` is
 * Docker's rule for a volume, three modules away from this word, and H-12's
 * lesson — restated by `COMPOSE_SERVICE_NAME_REGEX` when it declined the same
 * reuse — is that a charset is only correct for the context it was written
 * for. This one is written for an engine's database name.
 *
 * The engine rows' own `databaseName` (`postgres.dto.ts` and its neighbours)
 * is deliberately untouched here: that value is the container's
 * `POSTGRES_DB`-style environment, not a word in this module's pipeline, and
 * a backup names its database in its own column.
 */
export const DATABASE_NAME_REGEX = /^[a-zA-Z0-9_][a-zA-Z0-9_$.-]*$/;

export const DATABASE_NAME_MESSAGE =
  'Database name can only contain letters, numbers, dots, underscores, hyphens and dollar signs, and cannot start with a dot or a hyphen';

const databaseNameSchema = z
  .string()
  .min(1)
  .regex(DATABASE_NAME_REGEX, DATABASE_NAME_MESSAGE);

/**
 * Which service inside a Compose stack a compose backup is of — the same value
 * `createVolumeBackupSchema` carries one module over, and held to the same
 * rule.
 *
 * **Imported, not re-declared**, on `mount.dto.ts`' precedent with
 * `VOLUME_NAME_REGEX`: §2.4 wants the charset in one place, and these two
 * modules render the *same* string into the *same* two shapes —
 * `BackupsService.s3AppName` and `VolumeBackupsService.s3AppName` both build
 * `{appName}_{serviceName}` as an object key's leading segment, and both hand
 * it to `getComposeContainerCommand`'s `docker ps --filter label=…` word.
 * `COMPOSE_SERVICE_NAME_REGEX`' docblock carries the argument, including why
 * Compose's own charset and not `S3_KEY_REGEX`.
 *
 * `min(1)` beside it because the column is nullable and the emitters read any
 * falsy value as "no stack service": a caller that means "none" says `null` or
 * omits the field, and `''` was never a third way of saying it.
 */
const composeServiceNameSchema = z
  .string()
  .min(1)
  .regex(COMPOSE_SERVICE_NAME_REGEX, COMPOSE_SERVICE_NAME_MESSAGE);

/**
 * The engine user a compose backup's dump authenticates as — `min(1)`, and
 * deliberately no charset.
 *
 * **`min(1)` buys two things, and neither is the obvious one.** It is *not*
 * that an empty user reaches the dump differently from an absent one: every
 * builder writes `${quote([databaseUser ?? ''])}`, so `{ postgres: {
 * databaseUser: '' } }` and `{}` emit the identical `-U ''`. What it buys is:
 *
 * - **An empty user is not a working dump for any of the three engines that
 *   read this field.** `pg_dump -U ''`, `mongodump -u ''` and
 *   `mariadb-dump --user=` all fail against a stack that needs credentials at
 *   all, so the row can only ever have been a mistake — and `min(1)` turns it
 *   into a 400 on the request that made it instead of a red run every night
 *   with the engine's own error in the log.
 * - **It is the one value that can shadow a real one.**
 *   `BackupsService.credentialsFor` resolves
 *   `metadata.postgres?.databaseUser ?? metadata.mariadb?.… ?? metadata.mongo?.…`,
 *   and `??` falls through an absent object but **stops on an empty string** —
 *   so an empty `postgres.databaseUser` beside a populated `mongo` object does
 *   not fall through to it. That is the one case where `''` and absence differ,
 *   and it is the case the schema can rule out.
 *
 * Absence stays the way a stack says it needs no user: leave the engine's
 * object out. `composeServiceNameSchema` above takes `min(1)` for a related
 * reason and says it the same way.
 *
 * **What it does to a row that already stores `''`, since
 * {@link storedBackupShellSchema} picks this up on the same commit.** Such a
 * run is refused from now on rather than executed — and the bound on that is
 * that the run it refuses was already failing. For every engine that reads
 * this field the dump is `-U ''`/`-u ''`/`--user=`, which no server accepts,
 * so the only rows newly stopped are ones whose next dump would have died at
 * the engine with a less useful message. The one row that genuinely changes
 * outcome is contrived — a `mysql` compose backup, which dumps as `root` and
 * never reads `databaseUser`, carrying a stray empty `postgres` object beside
 * its own — and there is no console flow that writes one: the schedules form
 * is `backup-schedule-spec.tsx`'s database one and it sends no `metadata` at
 * all, so every row on this column came through a direct `POST /backups`.
 *
 * **And no charset, which is a judgement rather than an omission.** These are
 * the only values on the run path with no rule at all, and they land in
 * `pg_dump -U …`, `mariadb-dump --user=… --password=…`,
 * `mysqldump --password=…` and `mongodump -u … -p …`. It is tempting to give
 * them the treatment `prefix` and `database` just got, and it would be wrong
 * twice over:
 *
 * - **A password's job is to contain the characters a charset refuses.** `;`,
 *   `$`, a backtick, a space, a quote — the exact set that makes a charset
 *   worth having on a *name* is the set a generated password is graded on. A
 *   rule here would refuse working stacks, and it would refuse the ones with
 *   the best passwords first. `VOLUME_NAME_REGEX`'s docblock calls a charset
 *   correct only for the context it was written for; there is no context in
 *   which this one is correct.
 * - **The reason `database` needed one does not reach here.** That value is a
 *   bare positional word in three of the five dumps, so a leading `-` is read
 *   as a flag and `quote()` cannot help. Every credential below is instead the
 *   *value* of the flag before it — `-U`, `-u`, `-p`, `--user=`, `--password=`
 *   — consumed by that flag before any option parsing sees it. There is no
 *   flag reading and no path reading to close.
 *
 * So quoting is the whole defence for the `databaseUser` fields on this object,
 * it is in place at each of those words (H-36, H-37), and
 * `backup-shell-safety.spec.ts` proves it by running the emitted commands with
 * hostile payloads.
 *
 * **The three passwords are no longer words of any command**:
 * they are not interpolated at all, they travel in the environment the dump or
 * restore is executed with, and the emitted program names
 * `$CLOUDGATE_DB_PASSWORD` instead — because `ExecError` captures the command
 * and pino writes it six times over, so a value just made ciphertext
 * at rest was still cleartext in the journal. Everything above still holds and
 * matters more, not less: with no charset and no quoting between them and a
 * shell, what keeps a `$(…)` password inert is that the value crosses two
 * boundaries as data and is expanded inside `"…"`, which
 * `backup-credential-never-carried.spec.ts` re-runs these same payloads
 * through. See `commands/utils.ts`' `DATABASE_PASSWORD_ENV`.
 *
 * **The passwords keep no `min(1)`, and that asymmetry is on purpose.** An
 * empty password is a real configuration — `MYSQL_ALLOW_EMPTY_PASSWORD`, a
 * MariaDB user created without one — and `mariadb`'s and `mongo`'s objects
 * require both fields, so `''` is the only way such a stack can spell what it
 * has. Refusing it would stop the backups of the stacks least able to afford
 * losing them, which is H-21's failure mode inverted.
 *
 * The shape, rather than the charset, is what the stored-row guard checks these
 * for: nothing at the database boundary types this blob — TypeScript's
 * `encryptedJson<ComposeBackupMetadata>` is a compile-time claim about JSON the
 * column parses back, not a check on it — so a credential that is not a string
 * would render into the dump command as whatever it stringifies to.
 * {@link storedBackupShellSchema} says that.
 *
 * **And this schema is now load-bearing twice.** It is also what
 * `test/coding-standards/secret-bearing-columns.spec.ts` reads to *derive* that
 * `backup.metadata` must be encrypted at rest: the column declares no default
 * and its TypeScript type is erased, so this object is the only statement of
 * the blob's field names that survives to runtime. Renaming
 * `databasePassword`/`databaseRootPassword` to something no credential
 * vocabulary matches will fail that spec rather than silently lifting the
 * requirement.
 */
const composeDatabaseUserSchema = z.string().min(1);

/** Compose backups carry the engine credentials the dump command needs, since
 * no database row exists for the stack. */
const composeMetadataSchema = z.object({
  postgres: z.object({ databaseUser: composeDatabaseUserSchema }).optional(),
  mariadb: z
    .object({
      databaseUser: composeDatabaseUserSchema,
      databasePassword: z.string(),
    })
    .optional(),
  mongo: z
    .object({
      databaseUser: composeDatabaseUserSchema,
      databasePassword: z.string(),
    })
    .optional(),
  mysql: z.object({ databaseRootPassword: z.string() }).optional(),
});

export const createBackupSchema = z.object({
  schedule: cronExpressionSchema,
  enabled: z.boolean().optional(),
  prefix: backupPrefixSchema,
  database: databaseNameSchema,
  keepLatestCount: z.number().int().min(0).nullish(),
  destinationId: z.string().min(1),
  databaseType: z.enum(backupDatabaseTypes),
  backupType: z.enum(['database', 'compose']).default('database'),
  serviceId: z.string().min(1),
  serviceName: composeServiceNameSchema.optional(),
  metadata: composeMetadataSchema.optional(),
});

export class CreateBackupDto extends createZodDto(createBackupSchema) {}

// Update input (backupId travels in the URL); the backup cannot be re-pointed
// at another service, so serviceId stays out.
export const updateBackupSchema = z
  .object({
    schedule: cronExpressionSchema,
    enabled: z.boolean(),
    prefix: backupPrefixSchema,
    database: databaseNameSchema,
    keepLatestCount: z.number().int().min(0).nullable(),
    destinationId: z.string().min(1),
    databaseType: z.enum(backupDatabaseTypes),
    // `.nullable()`, not `.optional()`: `null` is how the stack service is
    // cleared, and the column is nullable.
    serviceName: composeServiceNameSchema.nullable(),
    metadata: composeMetadataSchema.nullable(),
  })
  .partial();

export class UpdateBackupDto extends createZodDto(updateBackupSchema) {}

// Restore input: restore targets a service directly (any dump the caller is
// entitled to can be restored, not only this backup's own), so it carries the
// service ref instead of a backupId.
//
// **`backupFile` stays `z.string().min(1)` on purpose.** A Destination's
// bucket is organization-wide, so this key used to reach *any* Service's dump
// and load it into one the caller could read — and the answer to that is not a
// tighter string. `BackupsService.checkBackupFileAccess` authorizes the key
// against the Service whose `appName` it sits under, which is a question about
// rows and entitlements rather than about shape; `BackupsService.restore`
// argues why that is the right instrument, and why the level it also raised was
// never going to be enough on its own.
export const restoreBackupSchema = z.object({
  databaseId: z.string().min(1),
  databaseType: z.enum(backupDatabaseTypes),
  backupType: z.enum(['database', 'compose']).default('database'),
  // The third spelling of `createBackupSchema.database`, and the same word in
  // the same commands: a restore's target reaches `credentialsFor` exactly as
  // a run's does, and it is the bare positional argument of the `mysql` and
  // `mariadb` clients. `backupFile` beside it keeps `z.string().min(1)` for
  // the reason the comment above gives — that one is an authorization
  // question, not a shape one.
  databaseName: databaseNameSchema,
  backupFile: z.string().min(1),
  destinationId: z.string().min(1),
  metadata: composeMetadataSchema
    .extend({ serviceName: composeServiceNameSchema.optional() })
    .optional(),
});

export class RestoreBackupDto extends createZodDto(restoreBackupSchema) {}

// The list-by-service query, mirroring mounts' apiFindMountByApplicationId
// (`?serviceId=&serviceType=`). serviceType is the backed-up service, so it is
// the five dumpable engines plus 'compose' — the only backup FK columns there
// are — and it decides both the FK filtered on and the parent lookup's table.
export const listBackupsSchema = z.object({
  serviceId: z.string().min(1),
  serviceType: z.enum(backupServiceTypes),
});

export class ListBackupsDto extends createZodDto(listBackupsSchema) {}

// The file-listing input — browse a destination's dumps (the restore UI's file
// picker), optionally through a server's rclone.
//
// No `serviceId` here, and that is a choice. The listing is bounded to
// the prefixes the caller is entitled to, but it is bounded by *filtering what
// comes back* rather than by being told which Service to browse:
// `BackupsService.visibleBackupFiles` argues why a filter and not a refusal,
// and it keeps this route the whole-bucket browse the console's search box
// already is.
export const listBackupFilesSchema = z.object({
  destinationId: z.string().min(1),
  search: z.string().default(''),
  // `.nullish()`, not `.optional()`: a row on the platform host carries
  // `serverId: null`, so `null` is the value a client reads off the resource
  // and sends back — ADR-0008's "no server row" contract. `.optional()`
  // answered 400 to the API's own output; widening keeps every payload that
  // was already accepted.
  serverId: z.string().nullish(),
});

export class ListBackupFilesDto extends createZodDto(listBackupFilesSchema) {}

/**
 * The four stored fields of a `backup` row that reach a shell word, held to the
 * rules above at the moment the dump pipeline is built.
 *
 * **Why a DTO is not enough, and this is not belt-and-braces on it.** A backup
 * is a cron job: `BackupsService.runScheduled` reads the row and
 * `buildRunScript` builds the script with **no request in the picture at all**.
 * A row written before a rule existed can therefore never reach a DTO again —
 * there is no write to validate — and the schedule goes on executing whatever
 * it stored, on the run host, indefinitely. `prefix` took
 * `bucketKeySegments` and `serviceName` took Compose's charset, both on
 * `create` and `update` only, so this module has had the older
 * rows and the newer half of the guard the wrong way round.
 * `storedVolumeBackupShellSchema` is the same schema one module over, and H-21
 * carries the argument in full.
 *
 * **Derived, not restated** (§2.4): `.pick()` and `.shape` off
 * {@link createBackupSchema}, so each rule lives in exactly one place and a
 * change to it changes this too, because there is nothing here to change.
 *
 * **The audit behind "four", so the next reader does not redo it.**
 * `buildRunScript` interpolates `prefix` (the rclone `rcat` target and
 * `pruneOldBackups`' `lsf`/`delete` path), `serviceName` (the object key's
 * leading segment, and the `docker ps --filter label=…` word), `database` and
 * `metadata`'s credentials (the engine's own dump arguments, through
 * `credentialsFor`). Everything else it interpolates comes from somewhere this
 * row cannot reach: `appName` is platform-minted through `cleanAppName`,
 * `databaseType` and `backupType` are enum columns, `logPath` is the run
 * recorder's, and `destination.bucket` belongs to an organization-scoped row.
 *
 * **What this can and cannot refuse, stated because the halves are uneven.**
 * It holds each field to exactly what the DTO holds a written one to and no
 * more — which is now a charset on all three names: {@link S3_KEY_REGEX} on
 * the path `prefix` denotes, {@link DATABASE_NAME_REGEX} on `database` and
 * {@link COMPOSE_SERVICE_NAME_REGEX} on `serviceName`. Being derived is what
 * makes those three arrive here on the same commit that puts them on the
 * route, and it is also why a rule that would have refused an existing row had
 * to be written not to: `backupPrefixSchema` argues the slashed and padded
 * prefixes this column can hold, and {@link DATABASE_NAME_REGEX} argues the
 * one class of row that is still refused and what an operator does about it.
 * `metadata`'s credentials are the one field with no charset behind them and
 * deliberately so; {@link composeMetadataSchema} carries why. So a `;` in a stored
 * credential is still data on the run host because every word carrying one is
 * `quote()`d (H-36, H-37), not because this caught it, and
 * `test/backups/backup-shell-safety.spec.ts` is what proves that half by
 * running the emitted commands. What closes here is the other half: a rule
 * exists and the row predates it.
 *
 * See `BackupsService.assertStoredValuesShellSafe` for the choke point this is
 * applied at, and for why a poisoned row fails its run loudly rather than being
 * skipped.
 */
export const storedBackupShellSchema = createBackupSchema
  .pick({ database: true })
  .extend({
    /**
     * The create schema's own field plus the segment rule, which lives in
     * `bucketKeySegments` as a throw because `create` and `update` want the
     * segments back. A run wants every poisoned field of the row named at once,
     * so it takes the same rule as a refinement — one spelling, two shapes.
     */
    prefix: createBackupSchema.shape.prefix.refine(
      (value) => !hasTraversalSegment(value),
      BUCKET_TRAVERSAL_MESSAGE,
    ),
    /**
     * Widened rather than restated: the charset is {@link createBackupSchema}'s
     * own field, unwrapped and then made absent-tolerant.
     *
     * **`null` and `''` are absent here, and that is not laxity.** The column is
     * nullable, so every database backup on the instance stores `null`; and
     * `BackupsService.s3AppName` branches on the value's *falsiness* before
     * interpolating it, while `buildRunScript` passes `?? ''` to the container
     * search, so `''` means what `null` means to the code that reads it. A guard
     * that refused either would refuse the run of every backup that names no
     * stack service — the H-21 failure mode inverted, a guard that stops the
     * backups it was added to protect.
     */
    serviceName: createBackupSchema.shape.serviceName
      .unwrap()
      .or(z.literal(''))
      .nullish(),
    /**
     * `.nullish()` for the same reason — a database backup's credentials come
     * off its engine row, so the column is `null` on all of them.
     *
     * **A shape check with no charset behind it, and worth having for that
     * shape.** These are the only values on this path that arrive as a
     * *parsed structure* rather than a column of their own — `jsonb` once
     * and `encryptedJson` now, which changes the encoding and not
     * this: TypeScript types the column and nothing checks it at the boundary,
     * so a credential that is not a string reaches `quote()` and renders as
     * whatever it stringifies to, inside the engine's dump command. If
     * anything, the conversion makes this guard matter slightly more — a
     * hand-run `UPDATE` can no longer be caught by `jsonb`'s own parse on the
     * way in, because the column is `text` now. If the DTO ever gives these
     * values a charset, this picks it up with no edit.
     */
    metadata: createBackupSchema.shape.metadata.unwrap().nullish(),
  });
