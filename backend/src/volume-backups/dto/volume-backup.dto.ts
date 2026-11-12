import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { serviceTypeEnum } from '../../applications/application.schema';
import { cronExpressionSchema } from '../../common/cron-expression';

// Create/update input. The owning service is named by serviceId +
// serviceType rather than eight FK fields (the mounts precedent).

// `schedule` is the cron expression, named as on the backup table, and it is
// the same string `SchedulingService.register` reads, so it
// takes the same refinement `schedule.dto.ts` does — imported, not re-declared
// (§2.4). It was once `z.string().min(1)`, so `{"schedule":"not a cron"}`
// answered 500 with the row already committed: exactly the hole already closed
// for schedules, still open here.

/**
 * The characters a Docker volume name may carry — Docker's own rule for
 * `docker volume create`, which is where every one of these ends up.
 *
 * It is here because `volumeName` was `z.string().min(1)` and reaches a shell
 * as root (H-19). `volume-backup-commands.ts` interpolates it into roughly
 * forty words of two generated scripts — a bare `mkdir -p`, `docker run -v`,
 * `docker volume rm`, and a long tail of `echo "…"` lines where `$(…)` and a
 * backtick substitute just as they do in a bare word — and the script goes to
 * `RemoteExecService.execAsyncRemote`. `deployment-engine/volume-lock.ts`
 * takes it too, as `LOCK_PATH="…"`. Nothing checked it anywhere on that path:
 * unlike `appName`, which every command builder in the tree relies on
 * `APP_NAME_REGEX` for, `volumeName` had no mint and no charset at all, so
 * `POST /volume-backups/restore` with `{"volumeName":"x$(id)"}` ran `id` on
 * the target Server as the account that drives Docker.
 *
 * **This refusal is not the fix those forty words need — quoting them is.**
 * `builders/build-strategy.ts` states the rule and H-12 states what happens
 * when a charset is left standing in place of it: a charset is only ever
 * correct for the context it was written for, and this one is correct for
 * none of them in particular. It is here because it makes every one of those
 * words safe in a single, reviewable change while the quoting is done, and
 * because it costs nothing real: a name Docker itself would refuse cannot
 * name a volume this application can back up or restore. It stands *behind*
 * the quoting, one word of which is already `quote()`d at
 * `volume-backup-commands.ts`'s `downloadStep`.
 *
 * Refused, not normalized, on `cleanAppName`'s precedent: a name rewritten to
 * be safe is not the name the caller asked for, and a volume-backup row that
 * disagrees with the volume it claims is worse than a 400.
 *
 * **And a charset is all there is: `volumeName` is deliberately *not* bound to
 * the parent Service's own volumes, the way `mounts`' `hostPath` is
 * deliberately not bound to anything (H-55).** The binding was asked for —
 * refuse a name the parent Service does not own instead of only charset-checking
 * it — and the answer is H-55's answer: what guards this is the trust boundary
 * around who may write a volume backup and on which Service, not a grammar.
 * Three facts decide it, and none of them is about cost:
 *
 * - **A restore legitimately names a volume that does not exist yet.**
 *   `buildVolumeRestoreScript` has a "Volume doesn't exist, proceeding with
 *   direct restore" branch on purpose — restoring onto a rebuilt or replacement
 *   host is a case the feature is *for*. Anything derived from
 *   `docker volume ls` on the target refuses exactly that, and refuses it at the
 *   worst possible moment.
 * - **The database does not know a compose stack's volumes.** A volume-type
 *   `mount` row is the volume set of an application or a database engine, but a
 *   compose stack's volumes are declared in its YAML and named by
 *   `docker compose`, and `mount.dto.ts` states that a compose stack's mount
 *   rows "are never assembled into a deploy spec". Binding to the mount rows
 *   would therefore refuse compose volume backups, which are the common case.
 * - **A pre-existing volume adopted by hand is a supported thing to back up.**
 *   Nothing in the product mints every volume a backup can be pointed at.
 *
 * **Rejected: refusing a name some *other* Service's mount row claims** — a
 * deny-known-foreign rule rather than an allow-known-own one. It is the strong
 * version of the idea: it needs no daemon and no YAML, it is one query, and it
 * would close the intra-organization case for the base member role, which the
 * level cannot. It is rejected because its false refusals land on the legitimate
 * case that is hardest to explain. A compose stack has no mount rows for its own
 * volumes, so an operator who has also mounted one of them into an application
 * by hand would find the compose stack refused a backup of *its own* volume —
 * and the refusal could not say why without turning the route into an oracle for
 * another Service's mounts (§2.2, ADR-0008). A rule that is correct for no
 * context in particular is what H-12 and this docblock's own third paragraph are
 * already about.
 *
 * **So the level carries the weight, and it is stated where somebody meets it:**
 * `VolumeBackupsService.create` argues why registering, re-pointing and
 * restoring each claim `service: ['update']` on the owning Service, and what
 * that costs a custom role holding `service: ['read']`.
 */
export const VOLUME_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export const VOLUME_NAME_MESSAGE =
  'Volume name can only contain letters, numbers, dots, underscores and hyphens, and must start with a letter or a number';

/**
 * The characters an S3 object key may carry on the way into a restore.
 *
 * Same sink, same reason, same standing: `backupFileName` is the full key of
 * the tarball to restore and was `z.string().min(1)`, and it lands in
 * `tar -tf /backup/${…}` inside a `docker run … bash -c "…"` and in five
 * `echo "…"` lines beside it. Constraining it costs nothing this application
 * can produce — every key it writes is
 * `{appName}/{prefix}/{volumeName}-{timestamp}.tar`, and all four parts are
 * inside this set — and a key outside it could not have been written by a
 * backup run of this volume, which is the only thing a restore claims to
 * read. `prefix` takes the same set for the same reason: it is the middle
 * segment of that key and reaches the same rclone words.
 */
export const S3_KEY_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/;

export const S3_KEY_MESSAGE =
  'Path can only contain letters, numbers, dots, underscores, hyphens and slashes, and must start with a letter or a number';

/**
 * The characters one service inside a Compose stack may be named — the
 * compose specification's own rule, which is where every one of these comes
 * from.
 *
 * **What broke first.** `serviceName` was `z.string().optional()` /
 * `.nullable()` with no charset at all, while every neighbour on the same two
 * schemas carried one, and it reaches two sinks (found by an audit
 * of every value that reaches a bucket path). `VolumeBackupsService.s3AppName`
 * renders `{appName}_{serviceName}`, which is the object key's **leading
 * segment** — the segment that is now an authorization boundary — and
 * roughly six words of two generated scripts interpolate it, the stack service
 * name and the two `com.docker.compose` labels among them. It was also outside
 * {@link storedVolumeBackupShellSchema}, so H-21's stored-row guard did not
 * cover the scheduled path at all.
 *
 * **Neither reach was live, and that was checked rather than assumed** — which
 * is why this is a charset rather than a fix. The bucket sink is bounded by the
 * *shape* of the name and not by validation: `serviceName` is suffixed onto
 * `parent.appName` and `bucketPrefixCandidates` trims the leading segment back
 * at every `_`, so `parent.appName` is always among the candidates
 * `checkTarballAccess` resolves and a compose row cannot make its key name
 * another Service. The shell sink is `quote()`d at every one of those words.
 * Both hold for reasons one edit away from not holding — a change to that
 * trimming, or a new builder that interpolates without `quote()` — and a field
 * with no rule at all is the one thing neither reason is about.
 *
 * **Docker Compose's rule rather than {@link S3_KEY_REGEX}, which is the
 * obvious reuse.** This value is not a path this application mints: it mirrors
 * a key under `services:` in the operator's own compose file, so §1.1's
 * *"third-party strings keep their own names"* makes Compose's own charset the
 * bound — `[a-zA-Z0-9._-]`, the set the compose specification keys its
 * `services` map on. `S3_KEY_REGEX` would be wrong in both directions at once:
 * it admits `/`, which is the one character that would turn
 * `{appName}_{serviceName}` into two path components and make the leading
 * segment somebody else's, and it forbids a leading `.` or `-`, which is a
 * legal service name in a file this application does not own.
 *
 * **Deliberately no leading-alphanumeric anchor**, unlike
 * {@link VOLUME_NAME_REGEX}, {@link S3_KEY_REGEX} and `templateIdSchema` —
 * each of which needed one because a leading `-` read as a flag or a `..`
 * segment climbed a path. Neither applies here: no word this value reaches
 * starts with it (it is always suffixed after `{appName}_`, or sits inside a
 * `label=…` word), and with no `/` in the set a `..` is a directory *name*
 * rather than a traversal. Anchoring anyway would buy nothing and would refuse
 * a name a real stack declares, which is the walked-back rule
 * `volume-backup.dto.spec.ts` opens by warning about.
 *
 * Refused, not normalized, on `cleanAppName`'s precedent: a row whose
 * `serviceName` disagrees with the stack service it claims backs up the wrong
 * volume and believes it.
 *
 * The Domain's own `serviceName` is deliberately **not** held to this and that
 * is not an inconsistency: `domain.dto.ts` records that it selects a service
 * inside the compose file through `compose.utils.ts` and is never interpolated
 * into a label, so it reaches neither of the two sinks above.
 */
export const COMPOSE_SERVICE_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;

export const COMPOSE_SERVICE_NAME_MESSAGE =
  'Compose service name can only contain letters, numbers, dots, underscores and hyphens';

export const createVolumeBackupSchema = z.object({
  name: z.string().min(1),
  volumeName: z.string().min(1).regex(VOLUME_NAME_REGEX, VOLUME_NAME_MESSAGE),
  prefix: z.string().min(1).regex(S3_KEY_REGEX, S3_KEY_MESSAGE),
  schedule: cronExpressionSchema,
  serviceType: z.enum(serviceTypeEnum.enumValues).default('application'),
  serviceId: z.string().min(1),
  /** Compose backups only: which service in the stack mounts the volume. */
  serviceName: z
    .string()
    .min(1)
    .regex(COMPOSE_SERVICE_NAME_REGEX, COMPOSE_SERVICE_NAME_MESSAGE)
    .optional(),
  turnOff: z.boolean().default(false),
  keepLatestCount: z.number().int().min(0).nullish(),
  enabled: z.boolean().optional(),
  destinationId: z.string().min(1),
});

export class CreateVolumeBackupDto extends createZodDto(
  createVolumeBackupSchema,
) {}

// The volume backup cannot be re-pointed at another service, so
// serviceId/serviceType stay out (backups precedent).
export const updateVolumeBackupSchema = z
  .object({
    name: z.string().min(1),
    volumeName: z.string().min(1).regex(VOLUME_NAME_REGEX, VOLUME_NAME_MESSAGE),
    prefix: z.string().min(1).regex(S3_KEY_REGEX, S3_KEY_MESSAGE),
    schedule: cronExpressionSchema,
    // `.nullable()`, not `.optional()`: `null` is how the console clears the
    // stack service, and the column is nullable.
    serviceName: z
      .string()
      .min(1)
      .regex(COMPOSE_SERVICE_NAME_REGEX, COMPOSE_SERVICE_NAME_MESSAGE)
      .nullable(),
    turnOff: z.boolean(),
    keepLatestCount: z.number().int().min(0).nullable(),
    enabled: z.boolean(),
    destinationId: z.string().min(1),
  })
  .partial();

export class UpdateVolumeBackupDto extends createZodDto(
  updateVolumeBackupSchema,
) {}

// The list route's input: one service's volume backups, by serviceId +
// serviceType (mounts precedent).
export const listVolumeBackupsSchema = z.object({
  serviceId: z.string().min(1),
  serviceType: z.enum(serviceTypeEnum.enumValues),
});

export class ListVolumeBackupsDto extends createZodDto(
  listVolumeBackupsSchema,
) {}

// Restore input: the tarball and the volume come from the request rather than
// from a volume-backup row, so the target service and volume travel here.
// Applications, compose stacks and a Server bucket's Garage volume are
// restore targets; a bucket's restore stops its Garage itself.
//
// **"Any volume" is load-bearing and stays that way; "any tarball" is
// not, and stopped being true once the key prefix was authorized.**
// `VOLUME_NAME_REGEX` above argues why the *target* volume is not bound to the
// named Service's own volumes, and `VolumeBackupsService.restore` carries the
// weight for that instead: the route claims `service: ['update']` on the Service
// it is pointed at, not the `'read'` it used to ride on. The *source* key is a
// different question and now has a different answer — a Destination's bucket is
// organization-wide, so `VolumeBackupsService.checkTarballAccess` requires the
// caller to be entitled to the Service whose prefix the key sits under.
// `backupFileName` keeps its `S3_KEY_REGEX` all the same: a charset cannot tell
// whose tarball a key names, which is why the answer is about rows rather than
// about shape.
export const restoreVolumeBackupSchema = z.object({
  serviceId: z.string().min(1),
  serviceType: z.enum(['application', 'compose', 'bucket']),
  volumeName: z.string().min(1).regex(VOLUME_NAME_REGEX, VOLUME_NAME_MESSAGE),
  /** Full S3 object key of the tarball to restore. */
  backupFileName: z.string().min(1).regex(S3_KEY_REGEX, S3_KEY_MESSAGE),
  destinationId: z.string().min(1),
});

export class RestoreVolumeBackupDto extends createZodDto(
  restoreVolumeBackupSchema,
) {}

/**
 * The three stored fields of a `volume_backup` row that reach a shell, held to
 * the rules above at the moment the backup script is built (H-21; `serviceName`
 * joined them later).
 *
 * **Why a DTO is not enough, and this is not belt-and-braces on it.** A volume
 * backup is a cron job: `VolumeBackupsService.runScheduled` reads the row and
 * builds the script with **no request in the picture at all**. A row written
 * before `volumeName` and `prefix` had any rule can therefore never reach a
 * DTO again — there is no write to validate — and the schedule goes on
 * executing whatever it stored, on the run host, indefinitely. That is the
 * X05-1 shape (a stored value the emitter keeps re-emitting), one step worse:
 * the domains case at least needed *someone* to make a request.
 *
 * **Derived, not restated** (§2.4): `.pick()` off the create schema, so the
 * charset lives in exactly one place and a change to it changes this too,
 * because there is nothing here to change. Same arrangement
 * `storedDomainRoutingSchema` has with `hostSchema` and `pathSchema`.
 *
 * See `VolumeBackupsService.assertStoredValuesShellSafe` for the choke point
 * this is applied at, and for why a poisoned row fails its run loudly rather
 * than being skipped.
 */
export const storedVolumeBackupShellSchema = createVolumeBackupSchema
  .pick({
    volumeName: true,
    prefix: true,
  })
  .extend({
    /**
     * Widened rather than restated: the charset is
     * {@link createVolumeBackupSchema}'s own field, unwrapped and then made
     * absent-tolerant, so there is still exactly one spelling of the rule.
     *
     * **`null` and `''` are absent here, and that is not laxity.** The column
     * is nullable, so every application, database and Redis backup on the
     * instance stores `null`; and `VolumeBackupsService.s3AppName` and
     * `stopTarget` both branch on the value's *falsiness* before interpolating
     * it, so `''` means what `null` means to the code that reads it. A guard
     * that refused either would refuse the run of every backup that names no
     * stack service — the H-21 failure mode inverted, a guard that stops the
     * backups it was added to protect.
     */
    serviceName: createVolumeBackupSchema.shape.serviceName
      .unwrap()
      .or(z.literal(''))
      .nullish(),
  });
