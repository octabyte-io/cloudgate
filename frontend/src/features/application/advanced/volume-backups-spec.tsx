import { z } from "zod";

import { Chip } from "@/components/console/chip";
import { Dash } from "@/components/console/dash";
import { Dot } from "@/components/console/dot";
import type { ServiceType } from "@/lib/api/endpoints/applications";
import type { Destination } from "@/lib/api/endpoints/destinations";
import type { VolumeBackup } from "@/lib/api/endpoints/volume-backups";
import { describeCron } from "@/lib/format/cron";

import type { ResourceSpec } from "./resource-spec";
import { example } from "@/components/console/form-spec";

/**
 * A named Docker volume, tarred to an S3 destination on a cron.
 *
 * Two fields on this form are decisions rather than settings, and both get a
 * sentence instead of a label:
 *
 * - **Stop the service while it runs.** A volume tarred while its service is
 *   writing to it produces a tarball that may not restore — half a database
 *   file, an index that does not match its data. Stopping first is downtime, and
 *   it is the only way to be certain. The form says which one you are choosing.
 * - **Keep the newest N.** Empty is *keep everything*, which is the safe default
 *   and also the one that quietly fills a bucket. A number here means older
 *   tarballs are deleted after each successful run, and the deletion is the part
 *   worth naming.
 *
 * `volumeName` is not a picker even though the Advanced tab knows this
 * Application's mounts: a backup can name a volume this Application uses without
 * a `mount` row (an image can declare its own `VOLUME`), so a list would be a
 * confident subset presented as the whole. The hint points at the mounts table
 * instead.
 */

const schema = z.object({
  name: z.string().trim().min(1, "A backup needs a name."),
  volumeName: z.string().trim().min(1, "A backup needs the volume to tar."),
  prefix: z.string().trim().min(1, "A backup needs a prefix in the bucket."),
  schedule: z
    .string()
    .trim()
    .min(1, "A backup needs a cron expression.")
    .refine((value) => value.trim().split(/\s+/).length === 5, {
      message: "A cron expression has five fields — minute, hour, day, month, weekday.",
    }),
  destinationId: z.string().min(1, "Choose where the tarball is written."),
  keepLatestCount: z
    .string()
    .trim()
    .refine((value) => value === "" || /^\d+$/.test(value), {
      message: "Keep a whole number of backups, or leave it empty to keep all.",
    }),
  turnOff: z.boolean(),
  enabled: z.boolean(),
});

export type VolumeBackupValues = z.infer<typeof schema>;

/**
 * An AI model's weights volume, `<appName>-weights`: a cache the
 * platform downloads again, which the API refuses to back up. The form
 * refuses it at the field, so it is never offered as a backup.
 */
export function weightsVolumeOf(application: {
  appName: string;
  aiModel: unknown;
}): string | null {
  return application.aiModel ? `${application.appName}-weights` : null;
}

function schemaFor(weightsVolume: string | null) {
  if (!weightsVolume) return schema;
  return schema.refine((values) => values.volumeName !== weightsVolume, {
    message: `${weightsVolume} holds this AI model's weights, which are downloaded again rather than backed up.`,
    path: ["volumeName"],
  });
}

export function volumeBackupsSpec({
  serviceId,
  serviceType = "application",
  ownVolume = null,
  destinations,
  destinationsPending,
  weightsVolume = null,
  create,
  update,
  remove,
}: {
  /** The Service the backups belong to — an Application unless said. */
  serviceId: string;
  serviceType?: ServiceType;
  /**
   * The one volume this Service's files are on, when it has exactly one — a
   * Server bucket's. A new backup starts on it.
   */
  ownVolume?: string | null;
  destinations: Destination[];
  destinationsPending: boolean;
  /** An AI model's weights volume, never offered as a backup. */
  weightsVolume?: string | null;
  create: (input: Record<string, unknown>) => Promise<unknown>;
  update: (
    volumeBackupId: string,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
  remove: (volumeBackupId: string) => Promise<unknown>;
}): ResourceSpec<VolumeBackup, VolumeBackupValues> {
  const byId = new Map(destinations.map((item) => [item.destinationId, item]));

  return {
    noun: "backup",
    plural: "backups",
    title: "Volume backups",
    lede: "Volumes tarred to an S3 destination on a cron.",
    icon: "db",
    addLabel: "Add a backup",
    emptyTitle: "No volume is being backed up",
    emptyBody:
      "Add a backup to copy a named volume off its Server to a destination. Nothing else does: a Deployment leaves the volume where it is.",
    defaultSort: { id: "name", dir: "asc" },
    getRowId: (row) => row.volumeBackupId,
    rowName: (row) => row.name,

    columns: [
      {
        id: "name",
        head: "Name",
        tone: "key",
        cell: (row) => (
          <span className="inline-flex items-center gap-2">
            <Dot status={row.enabled === false ? "inactive" : "active"} />
            <span className="min-w-0">{row.name}</span>
          </span>
        ),
        compare: (a, b) => a.name.localeCompare(b.name),
      },
      {
        id: "volumeName",
        head: "Volume",
        cell: (row) => <Chip variant="mono">{row.volumeName}</Chip>,
        compare: (a, b) => a.volumeName.localeCompare(b.volumeName),
      },
      {
        id: "schedule",
        head: "When",
        tone: "wrap",
        cell: (row) => (
          <span className="grid justify-items-start gap-0.5">
            <Chip variant="mono">{row.schedule}</Chip>
            <span className="text-meta text-tx-3">
              {describeCron(row.schedule)}
              {row.turnOff ? " · stops the service first" : ""}
            </span>
          </span>
        ),
      },
      {
        id: "destination",
        head: "Written to",
        tone: "wrap",
        cell: (row) => {
          const destination = byId.get(row.destinationId);
          return destination ? (
            <span className="grid justify-items-start gap-0.5">
              <span className="text-tx-2">{destination.name}</span>
              <span className="font-mono text-meta wrap-anywhere text-tx-3">
                {destination.bucket}/{row.prefix}
              </span>
            </span>
          ) : (
            // The destination list is Organization-scoped and this row holds an
            // id. A destination cannot be removed while this backup uses it
            // so a miss here means the list did not include it — not
            // that the bucket's credentials are gone.
            <Dash word="Destination is gone" />
          );
        },
      },
      {
        id: "keepLatestCount",
        head: "Keeps",
        tone: "num",
        cell: (row) =>
          row.keepLatestCount === null ? (
            <span className="text-tx-2">All</span>
          ) : (
            <span className="num">{row.keepLatestCount}</span>
          ),
      },
    ],

    schema: schemaFor(weightsVolume),
    fields: [
      {
        kind: "text",
        name: "name",
        label: "Name",
        placeholder: example("Nightly uploads"),
      },
      {
        kind: "text",
        name: "volumeName",
        label: "Volume",
        mono: true,
        placeholder: example("storefront-uploads"),
        hint: ownVolume
          ? `The named Docker volume to tar. This bucket's files are all on ${ownVolume}.`
          : weightsVolume
            ? `The named Docker volume to tar, from the Advanced tab's mounts table. Not ${weightsVolume}: the model's weights are downloaded again rather than backed up.`
            : "The named Docker volume to tar. The Advanced tab's mounts table lists the ones this Application mounts, though an image can declare volumes of its own that are not there.",
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
        hint: "Where the tarball is written. Destinations are managed for the whole Organization.",
      },
      {
        kind: "text",
        name: "prefix",
        label: "Prefix",
        mono: true,
        placeholder: "storefront/uploads",
        hint: "The path inside the bucket the tarballs go under.",
      },
      {
        kind: "text",
        name: "schedule",
        label: "Cron expression",
        mono: true,
        placeholder: "0 2 * * *",
        // Mono, not backticks: the literal characters rendered on screen here.
        // A hint is a `ReactNode`, so this costs no widening.
        hint: (
          <>
            Five fields. <code className="font-mono">0 2 * * *</code> is every
            day at two in the morning.
          </>
        ),
      },
      {
        kind: "text",
        name: "keepLatestCount",
        label: "Keep the newest",
        optional: true,
        placeholder: example("7"),
        hint: "Older tarballs under this prefix are deleted after each successful run. Empty keeps every one — safe, and the reason buckets grow without anyone noticing.",
      },
      {
        kind: "switch",
        name: "turnOff",
        label: "Stop the service while the backup runs",
        hint: "A volume tarred while it is being written to can produce a tarball that will not restore. Stopping first costs downtime and is the only way to be certain.",
      },
      {
        kind: "switch",
        name: "enabled",
        label: "Enabled",
        hint: "Turning it off keeps the backup and stops it firing. Nothing already written is deleted.",
      },
    ],

    toDefaults: (row) => ({
      name: row?.name ?? "",
      volumeName: row?.volumeName ?? ownVolume ?? "",
      prefix: row?.prefix ?? "",
      schedule: row?.schedule ?? "0 2 * * *",
      destinationId: row?.destinationId ?? "",
      keepLatestCount:
        row?.keepLatestCount === null || row?.keepLatestCount === undefined
          ? ""
          : String(row.keepLatestCount),
      turnOff: row?.turnOff ?? false,
      enabled: row?.enabled ?? true,
    }),

    // What `/volume-backups` asks of each write — `ResourceList` turns the
    // control off for a role without it.
    permissions: {
      create: { volumeBackup: ["create"] },
      update: { volumeBackup: ["update"] },
      remove: { volumeBackup: ["delete"] },
    },
    create: (values) =>
      create({
        ...body(values),
        serviceType,
        serviceId,
      }),
    update: (row, values) => update(row.volumeBackupId, body(values)),
    remove: (row) => remove(row.volumeBackupId),

    deleteNote: (row) => (
      <>
        <strong className="font-medium text-tx">{row.name}</strong> stops running
        and its row is deleted.{" "}
        <strong className="font-medium text-tx">
          The tarballs already in the destination are not touched
        </strong>{" "}
        — they stay in the bucket, and a restore can still use them.
      </>
    ),
  };
}

function body(values: VolumeBackupValues): Record<string, unknown> {
  return {
    name: values.name,
    volumeName: values.volumeName,
    prefix: values.prefix,
    schedule: values.schedule,
    destinationId: values.destinationId,
    keepLatestCount:
      values.keepLatestCount === "" ? null : Number(values.keepLatestCount),
    turnOff: values.turnOff,
    enabled: values.enabled,
  };
}
