import { useFormContext, useWatch } from "react-hook-form";

import type { BackupDatabaseType } from "@/lib/api/endpoints/backups";
import type { Destination } from "@/lib/api/endpoints/destinations";
import { describeCron } from "@/lib/format/cron";

import type { BackupScheduleValues } from "./backup-schedule-spec";

/**
 * The two hints on the schedule form that have to change as it is typed.
 *
 * A `FieldSpec.hint` is a `ReactNode`, and the spec that declares it is built by
 * the panel — outside the form, with no access to what is in the boxes. These are
 * that node: they render inside `Field`'s description, which puts them inside the
 * `FormProvider`, so each subscribes to the one value it reads and nothing else
 * on the form re-renders per keystroke.
 *
 * Both answer the same question — **what did I just say?** — for the two fields
 * whose value is not readable as written. `0 30 3 * * ` is not a time and
 * `nightly` is not a place; the reading and the object key are.
 *
 * Inline elements only. `Field` renders a hint inside a `<p>`.
 */

/**
 * The cron expression, in words, as it is typed.
 *
 * `describeCron` is the same reader the schedules table uses beside every row
 * (it lives in `lib/format`), so the sentence on the form is the sentence the
 * row will show — a schedule cannot read one way while being written and
 * another afterwards.
 *
 * It stays quiet while the expression is unreadable rather than printing its
 * "Not a five-field cron expression": the field's own error says that, in the
 * red the reader is already looking at, and two copies of one complaint is one
 * too many.
 */
export function CronReading() {
  const { control } = useFormContext<BackupScheduleValues>();
  const schedule = useWatch({ control, name: "schedule" }) ?? "";
  const reading = describeCron(schedule);
  const readable =
    schedule.trim() !== "" && reading !== "Not a five-field cron expression";

  return (
    <>
      Five fields — minute, hour, day of month, month, weekday.{" "}
      {readable ? (
        <span className="font-medium text-tx">{reading}.</span>
      ) : (
        <>
          <span className="font-mono">0 2 * * *</span> is every day at two in
          the morning.
        </>
      )}
    </>
  );
}

/**
 * Each engine's object extension — `BACKUP_COMMANDS[engine].extension` in
 * `backend/src/backups/commands`. Mongo's archive is BSON, LibSQL's is a tar of
 * sqld's data directory (objects written before it end `.sql.gz`), the
 * other three are SQL.
 */
const DUMP_EXTENSION = {
  postgres: "sql.gz",
  mysql: "sql.gz",
  mariadb: "sql.gz",
  mongo: "bson.gz",
  libsql: "tar.gz",
} as const satisfies Record<BackupDatabaseType, string>;

/**
 * Where the next dump lands, as the destination and the prefix are chosen.
 *
 * Built exactly the way `BackupsService.buildRunScript` builds it —
 * `bucket/<the database's appName>/<prefix>/<timestamp>.<ext>` — because the
 * prefix is only half of the key and the half that is missing is the half people
 * go looking under. The Dumps card below this form is a path box over the same
 * bucket, so a person who cannot find last night's dump is comparing this string
 * against that one.
 *
 * The timestamp shown is an example of the shape, not a prediction:
 * `getBackupTimestamp` is the run's ISO instant with `:` and `.` made
 * filename-safe.
 */
export function DumpPath({
  appName,
  databaseType,
  destinations,
}: {
  /** The engine row's own `appName` — its directory in the bucket. */
  appName: string;
  databaseType: BackupDatabaseType;
  destinations: Destination[];
}) {
  const { control } = useFormContext<BackupScheduleValues>();
  const destinationId = useWatch({ control, name: "destinationId" }) ?? "";
  const prefix = useWatch({ control, name: "prefix" }) ?? "";

  const bucket = destinations.find(
    (item) => item.destinationId === destinationId,
  )?.bucket;
  // `normalizeS3Path`: trimmed, no leading or trailing slash, and an empty
  // prefix collapses the segment rather than leaving a double slash.
  const cleaned = prefix.trim().replace(/^\/+|\/+$/g, "");
  const extension = DUMP_EXTENSION[databaseType];

  return (
    <>
      The path inside the bucket, under this database&rsquo;s own directory.
      Each run writes{" "}
      <span className="font-mono wrap-anywhere text-tx-2">
        {bucket ?? "<bucket>"}/{appName}/{cleaned ? `${cleaned}/` : ""}
        2026-08-11T02-00-00-000Z.{extension}
      </span>
    </>
  );
}
