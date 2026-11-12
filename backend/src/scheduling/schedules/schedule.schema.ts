import { relations, sql } from 'drizzle-orm';
import { boolean, check, pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import { application } from '../../applications/application.schema';
import { compose } from '../../compose/compose.schema';
import {
  encryptedText,
  generateAppName,
  isoTimestamp,
  nanoidPk,
} from '../../db/columns';
import { organization } from '../../organizations/organizations.schema';
import { server } from '../../servers/server.schema';

// A user-defined cron job. The scheduleType picks the target — a command
// docker-exec'd in an application/compose container, or a script run on a
// remote server / the cloudgate host itself. Exactly one of applicationId /
// composeId / serverId / organizationId is set to match.

export const shellTypeEnum = pgEnum('shell_type', ['bash', 'sh']);

export type ShellType = (typeof shellTypeEnum.enumValues)[number];

export const scheduleTypeEnum = pgEnum('schedule_type', [
  'application',
  'compose',
  'server',
  'cloudgate-server',
]);

export type ScheduleType = (typeof scheduleTypeEnum.enumValues)[number];

/**
 * The target that is set is the one `scheduleType` names, as a database fact
 * (the third case, which an earlier sweep flagged without enumerating).
 *
 * **`schedule` is the cleanest of the five and was nearly left out.** The
 * sweep reports it as a two-column table, because only `application_id` and
 * `compose_id` point at service tables; the rule is really four-way, and the
 * two the sweep cannot see are the two that matter most. `server_id` is a
 * whole host — `SchedulesService.runScheduled` materializes `script.sh` on it
 * and executes it — and `organization_id` is the `cloudgate-server` target,
 * which runs the script **on the Cloudgate host itself**, with no Service and
 * no Server in between. A row carrying `organization_id` beside a
 * `scheduleType` of `'server'` would put a script somebody wrote for their own
 * organization onto a named Server, or the reverse; nothing in the four-way
 * dispatch that reads `scheduleType` would notice.
 *
 * The `CASE`'s fourth arm is the reason this is a *consistency* check and not
 * the `num_nonnulls(…) = 1` half on its own: `organization_id` is not a
 * parent Service at all, so "at most one owner" is not even the right sentence
 * for this table. "The column `scheduleType` names is the one that is set" is.
 */
export const scheduleParentMatchesScheduleType = check(
  'schedule_parent_matches_schedule_type',
  sql`num_nonnulls("application_id", "compose_id", "server_id", "organization_id") = 1
    AND (CASE "schedule_type"
           WHEN 'application'      THEN "application_id"
           WHEN 'compose'          THEN "compose_id"
           WHEN 'server'           THEN "server_id"
           WHEN 'cloudgate-server' THEN "organization_id"
         END) IS NOT NULL`,
);

export const schedule = pgTable(
  'schedule',
  {
    scheduleId: nanoidPk('schedule_id'),
    name: text('name').notNull(),
    description: text('description'),
    cronExpression: text('cron_expression').notNull(),
    /** Names the script directory and the run-log directory. */
    appName: text('app_name')
      .notNull()
      .unique()
      .$defaultFn(() => generateAppName('schedule')),
    /** Compose schedules only: which service in the stack runs the command. */
    serviceName: text('service_name'),
    shellType: shellTypeEnum('shell_type').notNull().default('bash'),
    scheduleType: scheduleTypeEnum('schedule_type')
      .notNull()
      .default('application'),
    /**
     * What container schedules docker-exec in the target container.
     *
     * Encrypted at rest (ADR 0006) on the amendment made to ADR 0015's
     * rule: the rule was written about a **file body**, and this is
     * operator-authored **program text** that Cloudgate hands a host without
     * ever materializing it as a file. The argument does not depend on the file
     * — a `command` is where an operator writes `PGPASSWORD=…` and
     * `curl -H "Authorization: …"` for exactly the reason a cron script is, and
     * Cloudgate has no more idea which of its words are the secret. It is
     * `script`'s container-side sibling: same authorship, same credentials,
     * same blast radius, different delivery.
     *
     * **The echo went first, and that ordering was the whole of the first
     * fix.** Encrypting a column the code then prints is the docblock lie ADR
     * 0015 warns about, and this column had *two* echoes with two different
     * audiences:
     *
     * - `buildScheduleCommandScript`'s `echo "Running command: …"` writes the
     *   command verbatim into the run's deployment log, and **still does**.
     *   That log is reached through `DeploymentsService.resolveLogServer` →
     *   `scheduleRunServer` → `SchedulesService.findOne`, which is
     *   `checkRowAccess(ctx, row, 'read')` — the same predicate that answers
     *   `GET /schedules/:id` with this column in clear. The log reader is the
     *   column reader, and the file sits on the host that is about to run the
     *   command: the far end ADR 0006 does not defend, on the same reasoning
     *   that makes `script.sh` landing world-readable no argument against
     *   encrypting `script`. The echo is also how an operator learns what a run
     *   that failed *last night* ran, which the row stops being able to answer
     *   the moment the command is edited.
     * - Cloudgate's own **journal** was the widening, and it is closed
     *   structurally rather than masked. The command was a word of the program
     *   handed to `RemoteExecService`, so `ExecError` captured it and pino wrote
     *   it six times over — on every failed run, because the script turns the
     *   operator's own non-zero exit into a failed exec, and because none of
     *   the four masking patterns recognises a bare container command. It now
     *   travels in `RemoteExecOptions.env` under `SCHEDULE_COMMAND_HOLDER`,
     *   which is ADR 0015's first choice rather than a fifth elision pattern.
     *
     * A shape-preserving elision — the masking model, keeping every verb and
     * flag — was weighed and is **not implementable here**, and that is a fact
     * about the value rather than about the effort: the base64 shape works
     * because Cloudgate authors it, and a container command has no
     * Cloudgate-authored internal grammar. Every candidate token class can
     * itself be the secret: the first word (`PGPASSWORD=… pg_dump`), a flag's
     * value (`curl -H "Authorization: …"`) and the flag token itself (`mysql
     * -phunter2`, the documented form, which any keep-the-flags rule leaks
     * outright).
     *
     * **Nothing queries it.** No index on `schedule` in the 0066 snapshot, and
     * `SchedulesService` reads this column in exactly one place
     * (`buildRunScript`, into `buildScheduleCommandScript`); every `eq()` in
     * the service is on `scheduleId`, `enabled` or a foreign key, and the
     * readers outside `scheduling/` take `schedule.name` and the FK columns.
     *
     * **No migration.** `encryptedText` `dataType()`s to `'text'`, so there is
     * no DDL diff. `notNull` is safe without a default because `encryptValue`
     * short-circuits a falsy value: a script schedule's `''` is stored as `''`
     * and read back as `''`, so the column never holds a ciphertext of empty.
     * That `''` is minted in `SchedulesService.create` rather than
     * by a `.default('')` on the DTO — a default in front of the validation
     * made the inert-`command` refusal unstatable, because a guard could not
     * tell a client's value from zod's. **Dropping `notNull` was the other
     * candidate and was rejected**: it would give every reader three states —
     * `null`, `''` and a value — meaning one thing.
     * A value already stored without the `enc:v1:` prefix is passed through on
     * read (ADR 0006) and becomes ciphertext on the next write of *this*
     * column. Every half is pinned in `schedules.e2e-spec.ts`' *the command at
     * rest*.
     */
    command: encryptedText('command').notNull(),
    /**
     * What server/cloudgate-server schedules materialize as script.sh.
     *
     * Encrypted at rest (ADR 0006) on the argument that made `mount.content`
     * and `patch.content` `encryptedText`: **a file body is where an operator
     * puts a credential**, and this file body is a shell script that a host
     * executes unattended on a cron, which is where
     * `curl -H "Authorization: …"` and `PGPASSWORD=…` naturally get
     * written. A mount is the weaker case of the
     * two and was settled first; this column disagreed with its own siblings
     * for its whole life (and ADR 0015 for the rule that decides the
     * next such column).
     *
     * **Nothing queries it.** Encryption would be impossible if anything did —
     * AES-GCM under a random IV means `where script = $1` matches nothing,
     * which is why better-auth's `session.token` and `apikey.key` are exempt
     * from the secret-column sweep. There is no index on the column and no `where`, `like`
     * or `orderBy` over it: `SchedulesService` reads it in exactly one place
     * (`materializeScript`, into `buildScriptMaterializationCommand`),
     * the readers outside `scheduling/` take `schedule.name` and the FK
     * columns and never this one, and the console holds it in an editor keyed
     * by row id.
     *
     * **No migration, and none is possible to need.** `encryptedText`
     * `dataType()`s to `'text'`, so this change makes no DDL diff at all —
     * `drizzle-kit generate` emits no statement for `schedule.script` and its
     * snapshot entry is byte-identical to `meta/0064_snapshot.json`'s; a value
     * already stored without the `enc:v1:`
     * prefix is passed through on read (ADR 0006), so an existing row keeps
     * running its script and becomes ciphertext on the next write of *this*
     * column. Both halves are pinned in `schedules.e2e-spec.ts`.
     */
    script: encryptedText('script'),
    applicationId: text('application_id').references(
      () => application.applicationId,
      { onDelete: 'cascade' },
    ),
    composeId: text('compose_id').references(() => compose.composeId, {
      onDelete: 'cascade',
    }),
    serverId: text('server_id').references(() => server.serverId, {
      onDelete: 'cascade',
    }),
    /** cloudgate-server schedules only — the host has no service row, so the
     * schedule hangs off the organization that created it. */
    organizationId: text('organization_id').references(() => organization.id, {
      onDelete: 'cascade',
    }),
    enabled: boolean('enabled').notNull().default(true),
    timezone: text('timezone'),
    createdAt: isoTimestamp('created_at'),
  },
  () => [scheduleParentMatchesScheduleType],
);

export const scheduleRelations = relations(schedule, ({ one }) => ({
  application: one(application, {
    fields: [schedule.applicationId],
    references: [application.applicationId],
  }),
  compose: one(compose, {
    fields: [schedule.composeId],
    references: [compose.composeId],
  }),
  server: one(server, {
    fields: [schedule.serverId],
    references: [server.serverId],
  }),
  organization: one(organization, {
    fields: [schedule.organizationId],
    references: [organization.id],
  }),
}));

export type Schedule = typeof schedule.$inferSelect;
