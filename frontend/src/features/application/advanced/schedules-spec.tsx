import { z } from "zod";

import { Chip } from "@/components/console/chip";
import { Dash } from "@/components/console/dash";
import { Dot } from "@/components/console/dot";
import type { Schedule } from "@/lib/api/endpoints/schedules";
import { describeCron } from "@/lib/format/cron";

import type { ResourceSpec } from "./resource-spec";
import { example } from "@/components/console/form-spec";

/**
 * Cron entries that run a command **inside this Application's container**.
 *
 * An `application` schedule is a `docker exec`, which is the part worth saying on
 * the form: the command runs in the running container, so it sees that
 * container's filesystem and environment and nothing else — and if the
 * Application is not running when the cron fires, there is nothing to exec into.
 *
 * `scheduleType` is fixed to `application` here and not offered as a field. The
 * enum has four values, but a schedule cannot be re-pointed after creation
 * (`updateScheduleSchema` deliberately omits it), and the other three belong to
 * Server and Organization screens rather than to this one.
 */

const schema = z.object({
  name: z.string().trim().min(1, "A schedule needs a name."),
  description: z.string().trim(),
  cronExpression: z
    .string()
    .trim()
    .min(1, "A schedule needs a cron expression.")
    .refine((value) => value.trim().split(/\s+/).length === 5, {
      message: "A cron expression has five fields — minute, hour, day, month, weekday.",
    }),
  shellType: z.enum(["bash", "sh"]),
  command: z.string().trim().min(1, "A schedule needs a command to run."),
  timezone: z.string().trim(),
  enabled: z.boolean(),
});

export type ScheduleValues = z.infer<typeof schema>;

export function schedulesSpec({
  applicationId,
  create,
  update,
  remove,
}: {
  applicationId: string;
  create: (input: Record<string, unknown>) => Promise<unknown>;
  update: (scheduleId: string, input: Record<string, unknown>) => Promise<unknown>;
  remove: (scheduleId: string) => Promise<unknown>;
}): ResourceSpec<Schedule, ScheduleValues> {
  return {
    noun: "schedule",
    plural: "schedules",
    title: "Schedules",
    lede: "Commands run on a cron inside this Application's container.",
    icon: "clock",
    addLabel: "Add a schedule",
    emptyTitle: "Nothing is scheduled",
    emptyBody:
      "Add a schedule to run a command in this Application's own container on a cron — a nightly clean-up, a digest, a cache warm.",
    defaultSort: { id: "name", dir: "asc" },
    getRowId: (row) => row.scheduleId,
    rowName: (row) => row.name,

    columns: [
      {
        id: "name",
        head: "Name",
        tone: "key",
        cell: (row) => (
          <span className="inline-flex items-center gap-2">
            {/* The enabled state is the first thing to read on this row: a
                disabled schedule looks identical to an enabled one otherwise,
                and "why did it not run" starts here. */}
            <Dot status={row.enabled ? "active" : "inactive"} />
            <span className="min-w-0">{row.name}</span>
          </span>
        ),
        compare: (a, b) => a.name.localeCompare(b.name),
      },
      {
        id: "cronExpression",
        head: "When",
        tone: "wrap",
        cell: (row) => (
          <span className="grid justify-items-start gap-0.5">
            <Chip variant="mono">{row.cronExpression}</Chip>
            <span className="text-meta text-tx-3">
              {describeCron(row.cronExpression)}
              {row.timezone ? ` · ${row.timezone}` : ""}
            </span>
          </span>
        ),
      },
      {
        id: "command",
        head: "Command",
        tone: "wrap",
        cell: (row) =>
          row.command ? (
            <span
              title={row.command}
              className="font-mono text-meta wrap-anywhere text-tx-2"
            >
              {row.shellType} · {row.command}
            </span>
          ) : (
            <Dash word="Nothing set" />
          ),
      },
    ],

    schema,
    fields: [
      {
        kind: "text",
        name: "name",
        label: "Name",
        placeholder: example("Nightly clean-up"),
        hint: "What it is for. This is what the row is called and how a run is identified.",
      },
      {
        kind: "text",
        name: "description",
        label: "Description",
        optional: true,
      },
      {
        kind: "text",
        name: "cronExpression",
        label: "Cron expression",
        mono: true,
        placeholder: "0 3 * * *",
        // The example is set in mono rather than fenced in backticks, which is
        // what this sentence used to carry and what the operator read on screen.
        // A `FieldSpec.hint` has always been a `ReactNode`, so nothing
        // had to widen for this — the backticks were Markdown in a place
        // nothing renders Markdown. `<code>` and `font-mono` because that is
        // how the console sets a literal everywhere else, and the reading this
        // form's own database sibling gives through `CronReading` is the screen
        // that already had it right.
        hint: (
          <>
            Five fields: minute, hour, day of month, month, day of week.{" "}
            <code className="font-mono">0 3 * * *</code> is every day at three
            in the morning.
          </>
        ),
      },
      {
        kind: "text",
        name: "timezone",
        label: "Time zone",
        optional: true,
        mono: true,
        placeholder: "Europe/London",
        hint: "An IANA name. Left empty, the cron runs in the Server's own time zone — which is usually UTC and rarely what a nightly job was written for.",
      },
      {
        kind: "select",
        name: "shellType",
        label: "Shell",
        options: [
          { value: "bash", label: "bash" },
          { value: "sh", label: "sh" },
        ],
        hint: "The image has to have it. A minimal Alpine image has sh and not bash.",
      },
      {
        kind: "textarea",
        name: "command",
        label: "Command",
        mono: true,
        rows: 4,
        placeholder: example("npm run cleanup"),
        hint: "Run with docker exec inside the running container, so it sees that container's filesystem and variables. If the Application is not running when the cron fires, there is nothing to exec into.",
      },
      {
        kind: "switch",
        name: "enabled",
        label: "Enabled",
        hint: "Turning it off keeps the schedule and stops it firing.",
      },
    ],

    toDefaults: (row) => ({
      name: row?.name ?? "",
      description: row?.description ?? "",
      cronExpression: row?.cronExpression ?? "0 3 * * *",
      shellType: row?.shellType ?? "bash",
      command: row?.command ?? "",
      timezone: row?.timezone ?? "",
      enabled: row?.enabled ?? true,
    }),

    // **An empty optional is `undefined` when creating and `null` when updating**,
    // and the two are not interchangeable here: `createScheduleSchema` types
    // `description` / `timezone` as `z.string().optional()` — which refuses a
    // null — while `updateScheduleSchema` types them as `.nullable()`, because
    // clearing a value someone already set has to be expressible.
    //
    // Found by driving it: adding a schedule with no description sent
    // `description: null` and the backend answered 400 *"Invalid input: expected
    // string, received null"* on that field. The refusal landing under the right
    // input is `useApiForm` doing its job; sending it at all was this file's
    // mistake.
    // What `/schedules` asks of each write — `ResourceList` turns the
    // control off for a role without it.
    permissions: {
      create: { schedule: ["create"] },
      update: { schedule: ["update"] },
      remove: { schedule: ["delete"] },
    },
    create: (values) =>
      create({
        ...body(values, "omit"),
        scheduleType: "application",
        serviceId: applicationId,
      }),
    update: (row, values) => update(row.scheduleId, body(values, "clear")),
    remove: (row) => remove(row.scheduleId),

    deleteNote: (row) => (
      <>
        <strong className="font-medium text-tx">{row.name}</strong> stops firing
        and its row is deleted. A run already in progress is not interrupted.
      </>
    ),
  };
}

/** `empty` is what an untouched optional becomes — see the note on `create`. */
function body(
  values: ScheduleValues,
  empty: "omit" | "clear",
): Record<string, unknown> {
  const blank = empty === "clear" ? null : undefined;
  return {
    name: values.name,
    description: values.description === "" ? blank : values.description,
    cronExpression: values.cronExpression,
    shellType: values.shellType,
    command: values.command,
    timezone: values.timezone === "" ? blank : values.timezone,
    enabled: values.enabled,
  };
}
