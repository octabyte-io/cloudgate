import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { cronExpressionSchema } from '../../../common/cron-expression';
import { scheduleTypeEnum, shellTypeEnum } from '../schedule.schema';
import type { ScheduleType } from '../schedule.schema';

// Create/update bodies: the target is serviceId + scheduleType rather than
// separate applicationId/composeId/serverId fields (the mounts precedent).
// cloudgate-server schedules target the host itself, so they carry no serviceId
// — the organization scopes them.

// `cronExpressionSchema` was declared here and moved to
// `common/cron-expression.ts` once a review found `volume-backup.dto.ts`
// feeding the same `SchedulingService` from an unrefined `z.string().min(1)`.
// The timezone refinement stays: only a schedule carries one.

// `SchedulingService.register` throws synchronously on a zone `Intl` does not
// know — `Invalid timezone: …` — as `new CronJob` once did, and this
// is the same `Intl` check. Unvalidated, that throw
// landed in `syncJob` *after* the row was inserted, so a typo answered 500 and
// kept the schedule. Shared by the create and update shapes the way
// hostSchema is shared in domains/dto/domain.dto.ts.
const timezoneSchema = z.string().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Invalid timezone' },
);

/**
 * The two schedule types that docker-exec `command` in a container, and the two
 * that materialize `script` on a host.
 *
 * The partition is declared here, once, and read by all three places that used
 * to spell it out on their own: {@link scheduleRunsAScript} below, which
 * {@link createScheduleSchema}'s refusal and `SchedulesService.update`'s both
 * call, and `SchedulesService.materializeScript`, whose early return *was* the
 * only statement of it. That is what the fix was really about — the code
 * branched on this and the type did not — so the fix is one classification the
 * type and the code share, rather than two that agree today.
 *
 * **Two predicates read this pair, and it is still one question**.
 * {@link scheduleRunsACommand} is the other side, and it reads these tuples
 * rather than negating its sibling — so `buildRunScript`, `resolveTarget` and
 * `checkAccess`, the three sites that went on spelling
 * `=== 'application' || === 'compose'` out because they needed the narrowed
 * type, now ask it too.
 *
 * `schedule-inert-script.spec.ts` asserts the two tuples partition
 * `scheduleTypeEnum.enumValues` exactly, so a fifth `scheduleType` fails there
 * rather than landing in neither and inheriting whichever branch happens to be
 * the `else`.
 */
export const CONTAINER_SCHEDULE_TYPES = ['application', 'compose'] as const;

/** @see CONTAINER_SCHEDULE_TYPES */
export const HOST_SCHEDULE_TYPES = ['server', 'cloudgate-server'] as const;

/** Whether this schedule type materializes and runs a `script` at all. */
export const scheduleRunsAScript = (scheduleType: ScheduleType): boolean =>
  (HOST_SCHEDULE_TYPES as readonly string[]).includes(scheduleType);

/**
 * Whether this schedule type `docker exec`s a `command` at all.
 *
 * **One question, asked from the other side, and that is the ticket's own
 * question answered.** The fix extracted {@link scheduleRunsAScript} precisely
 * so the partition was stated once, and the single statement of it is the pair
 * of tuples above — so this predicate reads that pair rather than reading
 * `scheduleRunsAScript`. `!scheduleRunsAScript(type)` is the tempting spelling
 * and is worse in the only case that tells the two apart: a fifth
 * `scheduleType` falling into neither tuple would answer *"runs a command"*
 * under the negation and quietly accept a `command` nothing runs — the defect
 * this exists to end — while a membership test answers *"runs neither"* and
 * refuses both fields, which cannot be silent. `schedule-inert-script.spec.ts`'
 * partition assertion is what stops a fifth type ever reaching either, and
 * `schedule-inert-command.spec.ts` records what it costs if that ever fails.
 *
 * **A type guard, because three call sites in `SchedulesService` were spelling
 * the pair out and could not stop.** `buildRunScript`, `resolveTarget` and
 * `checkAccess` each wrote `=== 'application' || === 'compose'`, and a plain
 * `boolean` would not have let any of them stop: all three go on to pass the
 * narrowed type to `findParentService` or to fork on `'compose'`. So the pair
 * was doing classification *and* narrowing, which is why the one
 * classification did not reach them. Narrowing here is what makes the
 * partition stated once actually usable.
 */
export const scheduleRunsACommand = (
  scheduleType: ScheduleType,
): scheduleType is (typeof CONTAINER_SCHEDULE_TYPES)[number] =>
  (CONTAINER_SCHEDULE_TYPES as readonly string[]).includes(scheduleType);

/**
 * The one sentence both halves of the inert-script rule answer with.
 *
 * Declared once and read by two surfaces for §2.4's reason: this schema refuses
 * it on create, where `scheduleType` is in the body, and
 * `SchedulesService.update` refuses it against `current.scheduleType`, because a
 * schedule cannot be re-pointed and so an update body carries no type to
 * decide from. Two copies of the sentence is how the two come to disagree about
 * the rule.
 *
 * It names the remediation as well as the refusal, per §2.5: the operator who
 * hits this wanted a script to run, and the answer is a `server` schedule.
 */
export const INERT_SCRIPT_REFUSAL =
  'An application or compose schedule runs its `command` inside a container ' +
  'and never materializes a script, so `script` would be stored and ignored. ' +
  'Remove it, or use a `server` or `cloudgate-server` schedule to run a script.';

/**
 * {@link INERT_SCRIPT_REFUSAL}'s mirror, and declared once for the same reason:
 * the create schema refuses it against the body's `scheduleType` and
 * `SchedulesService.update` against the row's, because an update body carries
 * no type to decide from.
 *
 * It names the remediation as well as the refusal (§2.5) — the operator who
 * hits this wanted something to run on the machine, and on these two types that
 * is `script`.
 */
export const INERT_COMMAND_REFUSAL =
  'A server or cloudgate-server schedule runs its `script` on the host and ' +
  'never execs a command, so `command` would be stored and ignored. Remove ' +
  'it, or put it in `script`.';

/**
 * `POST /schedules`, with the inert `script` refused and the inert
 * `command` beside it.
 *
 * **What broke.** `script` was `z.string().optional()` for every
 * `scheduleType`, while `SchedulesService.materializeScript` returns early for
 * `application` and `compose`. So a container schedule accepted a script body,
 * persisted it — encrypted, so an operator's credentials sat in a
 * column nothing would ever read — and never wrote it anywhere: a silent no-op
 * field on half the types.
 *
 * **This is the ticket's problem and deliberately not its shape, and the reason
 * is measured rather than stylistic.** The ticket asked for a discriminated
 * union on `scheduleType`, and a `z.discriminatedUnion` cannot be a DTO here:
 * every DTO in this tree is `class X extends createZodDto(schema)`, and
 * nestjs-zod types the base constructor as `ReturnType<schema['parse']>`, so a
 * union output is **TS2509** — *"Base constructor return type is not an object
 * type or intersection of object types with statically known members"*. Three
 * further costs were measured on the way to that wall, and all three are
 * avoided here:
 *
 * - A `z.object` arm without a `script` key refuses **nothing**: zod strips
 *   unknown keys, so the union alone silently *drops* an inert script, which is
 *   worse than today where the row at least shows what was sent. The refusal
 *   has to be an explicit member either way — and an explicit member works
 *   identically in a refinement, which is what makes the union's remaining
 *   benefit purely compile-time, and therefore exactly the benefit TS2509
 *   denies.
 * - `z.discriminatedUnion` matches the discriminator against the *raw* input
 *   before any arm parses, so a `.default()` on it does not help: a body
 *   omitting `scheduleType` — legal since this route shipped, and
 *   `default: application` in the published `openapi.json` — answers *"Invalid
 *   discriminator value"*. Fixing that needs a `z.preprocess`, whose input type
 *   is `unknown`, which erases `z.input<typeof createScheduleSchema>` — the
 *   type `schedules.e2e-spec.ts`' fixtures are deliberately built from — and
 *   removes `.shape`, which `test/common/cron-expression.spec.ts` reads.
 * - A plain `z.union` needs no preprocess and loses the message, which is the
 *   thing the ticket actually asked for: measured, every refusal collapses to
 *   `invalid_union` / *"Invalid input"* at path `[]`.
 *
 * What the refinement gives instead is the same 400, at the same field path,
 * with the same sentence — and one classification, {@link scheduleRunsAScript},
 * that the schema and `materializeScript` now both branch on. A union would
 * have restated the partition a third time in its arms. The cost, recorded so
 * it is not rediscovered: a refinement is invisible to JSON Schema, so
 * `openapi.json` still advertises `script` on every type, exactly as it still
 * says nothing about `requireServiceId`'s rule or `cronExpressionSchema`'s.
 *
 * The *presence* of the key is what is refused, `''` and `null` included: a
 * client told the field exists for empty values has been told the field exists.
 *
 * **`command`'s half landed here too, in one `superRefine` rather than two**.
 * Two refinements over one object would report a body that is wrong
 * twice one round trip at a time; one that adds both issues answers both. The
 * two rules are not spelled the same way and the field docblocks say why —
 * `script` refuses presence, `command` refuses a non-empty value — and neither
 * decides the partition for itself: {@link scheduleRunsAScript} and
 * {@link scheduleRunsACommand} both read the tuples above, which is the one
 * place it is stated.
 */
export const createScheduleSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    cronExpression: cronExpressionSchema,
    scheduleType: z.enum(scheduleTypeEnum.enumValues).default('application'),
    /** The target application/compose/server — absent for cloudgate-server. */
    serviceId: z.string().optional(),
    /** Compose schedules only: which service in the stack runs the command. */
    serviceName: z.string().optional(),
    shellType: z.enum(shellTypeEnum.enumValues).default('bash'),
    /**
     * What container schedules docker-exec in the target container.
     *
     * **The `.default('')` is gone, and that is the whole fix.**
     * `SchedulesService.buildRunScript` never reads this for `server` or
     * `cloudgate-server`, so it was exactly as inert there as `script` is on
     * the two container types — and the earlier fix declined to refuse it
     * because the default manufactured a value for *every* request, so a
     * refusal could not tell a client that sent one from zod filling it in.
     * Absent now means absent, as `script`'s `.optional()` already did, and the
     * `''` the `notNull` column needs is supplied by `SchedulesService.create`
     * — behind the refusal instead of inside the validation that has to see
     * through it. The manufacture did not go away; it moved to where it stops
     * lying to the guard, beside the `scheduleId` and `appName` that are minted
     * there for a related reason.
     *
     * **`''` is admitted where `script`'s rule refuses even an empty value**,
     * and the asymmetry is not an oversight: `''` is this column's own resting
     * value for the two host types, so refusing it would refuse the byte the
     * row is about to hold, every fixture that spells the empty command out,
     * and the `PATCH` that *clears* an inert command a row already holds — the
     * write nothing in a guard may refuse. So a **non-empty** `command` is what
     * a host schedule cannot carry.
     *
     * Dropping `notNull` from the column was the other candidate and was
     * rejected: it would give every reader three states meaning one thing for a
     * column whose `''` already reads back as `''`.
     */
    command: z.string().optional(),
    /** What server/cloudgate-server schedules materialize as script.sh. */
    script: z.string().optional(),
    enabled: z.boolean().optional(),
    timezone: timezoneSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.script !== undefined &&
      !scheduleRunsAScript(value.scheduleType)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['script'],
        message: INERT_SCRIPT_REFUSAL,
      });
    }
    // A *non-empty* command, unlike `script`'s presence rule: `''` is the
    // `notNull` column's resting value on these two types, and the field's own
    // docblock carries why refusing it would refuse the row's own bytes.
    if (value.command && !scheduleRunsACommand(value.scheduleType)) {
      ctx.addIssue({
        code: 'custom',
        path: ['command'],
        message: INERT_COMMAND_REFUSAL,
      });
    }
  });

export class CreateScheduleDto extends createZodDto(createScheduleSchema) {}

// The schedule cannot be re-pointed at another target, so serviceId and
// scheduleType stay out (backups precedent).
export const updateScheduleSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().nullable(),
    cronExpression: cronExpressionSchema,
    serviceName: z.string().nullable(),
    shellType: z.enum(shellTypeEnum.enumValues),
    command: z.string(),
    script: z.string().nullable(),
    enabled: z.boolean(),
    timezone: timezoneSchema.nullable(),
  })
  .partial();

export class UpdateScheduleDto extends createZodDto(updateScheduleSchema) {}

// `GET /schedules` query (id + scheduleType); cloudgate-server listings need no
// id — the active organization scopes them.
export const listSchedulesSchema = z.object({
  scheduleType: z.enum(scheduleTypeEnum.enumValues),
  serviceId: z.string().optional(),
});

export class ListSchedulesDto extends createZodDto(listSchedulesSchema) {}
