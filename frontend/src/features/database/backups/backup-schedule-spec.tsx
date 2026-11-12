import { z } from "zod";

import { Chip } from "@/components/console/chip";
import { Dash } from "@/components/console/dash";
import { Dot } from "@/components/console/dot";
import { LinkButton } from "@/components/console/link-button";
import type { ResourceSpec } from "@/components/console/resource-spec";
import type {
  BackupDatabaseType,
  BackupListItem,
  CreateBackupInput,
  UpdateBackupInput,
} from "@/lib/api/endpoints/backups";
import type { Destination } from "@/lib/api/endpoints/destinations";
import { describeCron } from "@/lib/format/cron";

import { CronReading, DumpPath } from "./schedule-hints";
import { example } from "@/components/console/form-spec";

/**
 * A dump of one database, written to an S3 destination on a cron —
 * as a `ResourceSpec`, which is what
 * was asked for. Before it, this tab could list a schedule and run or pause
 * one, and the form was the missing half: creating, editing and removing were
 * `POST`, `PATCH` and `DELETE` with no screen.
 *
 * It is the same configuration file `volume-backups-spec.tsx` is, deliberately —
 * a volume tarred to a bucket on a cron and a database dumped to one are the same
 * screen with a different noun, and the console has one description of "a table of
 * child records with add, edit and delete" (`resource-spec.ts`). Reusing it is what
 * makes this tab indistinguishable from the Application tab beside it.
 *
 * Four fields on it are decisions rather than settings, and each gets said where
 * it is made:
 *
 * 1. **The cron expression** is read back in words as it is typed
 *    (`CronReading`), by the same reader the table uses beside every row. A
 *    schedule nobody can read is one nobody checks.
 * 2. **The destination is chosen, never typed.** It is an id the backend resolves
 *    org-scoped, and a bucket name in a box would be a request that fails at save
 *    time for a reason the form could have known.
 * 3. **The prefix is half of an object key**, and `DumpPath` shows the other half
 *    — the database's own `appName` directory and the timestamped file. That is
 *    the string to search for in the Dumps card below.
 * 4. **Retention deletes.** Empty keeps every dump; a number prunes to the newest
 *    N *after each successful run*, and the pruning is the part worth naming.
 *
 * The one thing this spec cannot offer is a way to re-point a schedule at another
 * database: `serviceId` is not on `UpdateBackupDto`, because the FK column a
 * backup hangs off is decided when the row is written.
 */

/**
 * Five fields, and only characters a cron field can hold.
 *
 * The backend hands the expression to the `cron` package, which would also take
 * a six-field form with seconds — but `describeCron` reads five, the Application's
 * schedules and volume backups are five, and a dump that can be asked to run every
 * second is a footgun rather than a feature. So the console's answer is five
 * everywhere, and this refusal says which five.
 */
const CRON_FIELD = /^[\d*,\-/A-Za-z]+$/;

const schema = z.object({
  database: z
    .string()
    .trim()
    .min(1, "Name the database inside this engine to dump."),
  destinationId: z.string().min(1, "Choose where the dumps are written."),
  prefix: z
    .string()
    .trim()
    .min(1, "A schedule needs a prefix in the bucket."),
  schedule: z
    .string()
    .trim()
    .min(1, "A schedule needs a cron expression.")
    .refine((value) => value.split(/\s+/).length === 5, {
      message:
        "A cron expression has five fields — minute, hour, day of month, month, weekday.",
    })
    .refine((value) => value.split(/\s+/).every((f) => CRON_FIELD.test(f)), {
      message:
        "A cron field holds digits, * , - and / only. 0 2 * * * is every day at two in the morning.",
    }),
  keepLatestCount: z
    .string()
    .trim()
    .refine((value) => value === "" || /^\d+$/.test(value), {
      message: "Keep a whole number of dumps, or leave it empty to keep all.",
    })
    .refine((value) => value === "" || Number(value) >= 1, {
      message: "Keep at least one dump. Leave it empty to keep every one.",
    }),
  enabled: z.boolean(),
});

export type BackupScheduleValues = z.infer<typeof schema>;

export function backupScheduleSpec({
  databaseId,
  databaseName,
  appName,
  databaseType,
  suggestedDatabase,
  databaseHint,
  destinations,
  destinationsPending,
  noDestination,
  create,
  update,
  remove,
}: {
  /** The engine row's id — a database backup's `serviceId`. */
  databaseId: string;
  /** What the console calls this database. Names it in the copy. */
  databaseName: string;
  /** The engine's directory in the bucket, ahead of every prefix. */
  appName: string;
  /** Which dump tool runs. `DATABASE_KIND[kind].backup`, never null here. */
  databaseType: BackupDatabaseType;
  /** The engine's own `databaseName` column, when it has one. */
  suggestedDatabase: string;
  /** What "database" means to this engine's dump command. */
  databaseHint: string;
  destinations: Destination[];
  destinationsPending: boolean;
  /**
   * The Organization has no destination, read and not refused. A
   * schedule then has nowhere to write, so Add becomes a link to connect one.
   */
  noDestination: boolean;
  create: (input: CreateBackupInput) => Promise<unknown>;
  update: (backupId: string, input: UpdateBackupInput) => Promise<unknown>;
  remove: (backupId: string) => Promise<unknown>;
}): ResourceSpec<BackupListItem, BackupScheduleValues> {
  return {
    noun: "schedule",
    plural: "schedules",
    title: "Scheduled dumps",
    lede: `What Cloudgate dumps out of ${databaseName}, and where each dump goes.`,
    icon: "clock",
    addLabel: "Add a schedule",
    tableLabel: `Backup schedules for ${databaseName}`,
    emptyTitle: "Nothing is dumped on a schedule",
    emptyBody: noDestination
      ? "A schedule dumps this database on a cron and writes the file to an S3 destination, and none is connected yet. Connect one in Settings, then add a schedule here."
      : "A schedule dumps this database on a cron and writes the file to an S3 destination. Nothing else here copies the data off its Server — rebuilding the database throws its volume away.",
    addInstead: noDestination ? (
      <LinkButton href="/settings/destinations" size="sm" variant="pri">
        Connect a destination
      </LinkButton>
    ) : undefined,
    // By the hour it fires rather than by the row's age. **There is no Created
    // column** and that is a width decision, measured: five columns plus the four
    // controls a row carries here — Run now, the cron toggle, Edit, Remove — came
    // to 928px inside an 825px card on a 1511px window, so Remove sat off the
    // right edge behind a scrollbar. When a schedule was written is the least
    // useful of the five and the form does not show it either.
    defaultSort: { id: "schedule", dir: "asc" },
    getRowId: (row) => row.backupId,
    /**
     * The database **and** the cron, because the database alone is not unique:
     * a nightly full dump and a half-hourly one of the same database are the
     * obvious pair to have, and "Remove catalog?" cannot tell them apart.
     *
     * No leading article, and that is not a style choice — `DeleteResourceModal`
     * opens a sentence with this string (`${name} removed.`), so "the catalog
     * dump" ships a lower-case "the" as the first word of a toast. Driven: it
     * did.
     */
    rowName: (row) => `${row.database} on ${row.schedule}`,

    columns: [
      {
        id: "schedule",
        head: "When",
        tone: "key",
        compare: (a, b) => a.schedule.localeCompare(b.schedule),
        cell: (row) => (
          <span className="grid justify-items-start gap-0.5">
            <span className="inline-flex items-center gap-2">
              <Dot status={row.enabled ? "active" : "inactive"} />
              <Chip variant="mono">{row.schedule}</Chip>
            </span>
            {/* `whitespace-normal` because the cell is nowrap by default and
                "Every Monday at 03:00 · paused" held this column open at 202px,
                which is where the row's four controls started overflowing the
                card. The reading is a sentence; it can wrap like one. */}
            <span className="text-meta whitespace-normal text-tx-3">
              {describeCron(row.schedule)}
              {row.enabled ? "" : " · paused"}
            </span>
          </span>
        ),
      },
      {
        id: "database",
        head: "Database",
        className: "font-mono",
        compare: (a, b) => a.database.localeCompare(b.database),
        cell: (row) => row.database || <Dash />,
      },
      {
        id: "destination",
        head: "Written to",
        // Not `tone: "wrap"`: that carries a 220px floor (`min-w-55`), and this
        // table cannot spare it — see the note on `defaultSort`. The two lines
        // wrap on their own instead.
        compare: (a, b) => a.destination.name.localeCompare(b.destination.name),
        cell: (row) => (
          <span className="grid justify-items-start gap-0.5">
            <span>{row.destination.name}</span>
            {/* The whole key, `appName/` included. The first card showed
                `bucket/prefix`, which is not where the file is: every dump goes
                under the engine's own directory, and a prefix on its own does not
                find it in the Dumps card below. */}
            <span className="font-mono text-meta whitespace-normal wrap-anywhere text-tx-3">
              {row.destination.bucket}/{appName}/{row.prefix.replace(/^\/+/, "")}
            </span>
          </span>
        ),
      },
      {
        id: "retention",
        head: "Kept",
        tone: "num",
        compare: (a, b) => (a.keepLatestCount ?? 0) - (b.keepLatestCount ?? 0),
        // Null and 0 both mean "keep every one" (`keepLatestCount` on the row),
        // and that is a real setting rather than a missing value — so it gets a
        // word instead of a dash. The word is the volume-backup list's word, and
        // it is one word on purpose: at "every dump" this column was 93px wide
        // and the row's four controls no longer fitted the card.
        cell: (row) =>
          row.keepLatestCount && row.keepLatestCount > 0 ? (
            <span className="num">{row.keepLatestCount}</span>
          ) : (
            <span className="text-tx-2">All</span>
          ),
      },
    ],

    schema,
    fields: [
      {
        kind: "text",
        name: "database",
        label: "Database",
        mono: true,
        placeholder: example("storefront"),
        hint: databaseHint,
      },
      {
        kind: "select",
        name: "destinationId",
        label: "Destination",
        pending: destinationsPending,
        placeholder: "Choose a destination",
        options: destinations.map((item) => ({
          value: item.destinationId,
          label: item.name,
          detail: item.bucket,
        })),
        hint: "Where the dumps are written. Destinations are managed for the whole Organization.",
      },
      {
        kind: "text",
        name: "prefix",
        label: "Prefix",
        mono: true,
        placeholder: example("nightly"),
        hint: (
          <DumpPath
            appName={appName}
            databaseType={databaseType}
            destinations={destinations}
          />
        ),
      },
      {
        kind: "text",
        name: "schedule",
        label: "Cron expression",
        mono: true,
        placeholder: "0 2 * * *",
        hint: <CronReading />,
      },
      {
        kind: "text",
        name: "keepLatestCount",
        label: "Keep the newest",
        optional: true,
        placeholder: example("7"),
        hint: "Older dumps under this prefix are deleted after each successful run. Empty keeps every one — safe, and the reason buckets grow without anyone noticing.",
      },
      {
        kind: "switch",
        name: "enabled",
        label: "Run on the cron",
        hint: "The same setting the row's Pause and Resume change. Off keeps the schedule and stops it firing; Run now still works, and nothing already dumped is deleted.",
      },
    ],

    toDefaults: (row) => ({
      database: row?.database ?? suggestedDatabase,
      destinationId: row?.destinationId ?? "",
      prefix: row?.prefix ?? "",
      schedule: row?.schedule ?? "0 2 * * *",
      // 0 and null are the same setting on the row — keep every dump — and the
      // table already reads both that way, so the box shows what they mean
      // rather than which of the two is stored.
      keepLatestCount:
        row?.keepLatestCount && row.keepLatestCount > 0
          ? String(row.keepLatestCount)
          : "",
      enabled: row?.enabled ?? true,
    }),

    // What `/backups` asks of each write — `ResourceList` turns the
    // control off for a role without it.
    permissions: {
      create: { backup: ["create"] },
      update: { backup: ["update"] },
      remove: { backup: ["delete"] },
    },
    create: (values) =>
      create({
        ...body(values),
        databaseType,
        backupType: "database",
        serviceId: databaseId,
      }),
    update: (row, values) => update(row.backupId, body(values)),
    remove: (row) => remove(row.backupId),

    deleteNote: (row) => (
      <>
        This schedule stops firing and its row is deleted.{" "}
        <strong className="font-medium text-tx">
          The dumps already in {row.destination.name} are not touched
        </strong>{" "}
        — they stay in the bucket, and a restore can still use them.
      </>
    ),
  };
}

function body(values: BackupScheduleValues) {
  return {
    schedule: values.schedule,
    prefix: values.prefix,
    database: values.database,
    destinationId: values.destinationId,
    enabled: values.enabled,
    keepLatestCount:
      values.keepLatestCount === "" ? null : Number(values.keepLatestCount),
  };
}
