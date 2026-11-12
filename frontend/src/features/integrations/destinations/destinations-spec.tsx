import { z } from "zod";

import { Dash } from "@/components/console/dash";
import type { Column } from "@/components/console/data-table";
import type { ResourceSpec } from "@/components/console/resource-spec";
import {
  destinationsApi,
  type Destination,
  type DestinationInput,
} from "@/lib/api/endpoints/destinations";
import { redactSecrets } from "@/lib/format/redact";
import { example } from "@/components/console/form-spec";
import {
  probeServerBlocked,
  probeServerField,
  type ProbeFrom,
} from "@/lib/forms/probe-server-picker";

/**
 * An S3-compatible backup destination, as a `ResourceSpec`.
 *
 * **The test is the point of this screen.** Every other field can be wrong in a
 * way you find out about immediately; a bucket you cannot write to is discovered
 * during a restore, which is the worst possible moment. So `spec.test` is filled
 * in here, and what it reports is not pass/fail: the backend runs
 * `rclone ls --retries 1 --timeout 10s ":s3:<bucket>"` and hands back **rclone's
 * own message** on a 400, so a wrong region, a wrong key and a bucket that does
 * not exist read as three different sentences.
 *
 * **There are two routes behind the one button, and which one runs is decided by
 * the secret box.** Typed in, and the test probes the values in the form — the
 * create case, and the only thing that can work before a row exists. Left empty
 * on an edit, and the test probes the destination *as it is saved*, through
 * `POST /:id/test-connection`,
 * which is the question that matters once the thing has been running for a
 * while. The result sentence says which of the two happened, because "it
 * worked" means different things.
 */

const schema = z.object({
  /**
   * Which saved destination this form is editing, or `""` on an add.
   *
   * Not a control — no `FieldSpec` names it, so nothing renders it. It is in the
   * values because `ResourceList` builds one spec for both dialogs and hands
   * `test.run` the values and nothing else, and "am I editing something that
   * already exists?" is the fact the test now turns on.
   */
  destinationId: z.string(),
  name: z.string().min(1, "A destination needs a name."),
  provider: z.string(),
  endpoint: z.string().min(1, "A destination needs an endpoint."),
  region: z.string(),
  bucket: z.string().min(1, "A destination needs a bucket."),
  accessKey: z.string().min(1, "A destination needs an access key."),
  secretAccessKey: z.string(),
  /**
   * The Server the test runs from — only asked on the Hosted instance,
   * `""` everywhere else (this Cloudgate host). Never saved: it is where you
   * ask from, not a property of the destination.
   */
  serverId: z.string(),
});

export type DestinationValues = z.infer<typeof schema>;

export const destinationColumns: Column<Destination>[] = [
  {
    id: "name",
    head: "Name",
    tone: "key",
    compare: (a, b) => a.name.localeCompare(b.name),
    cell: (row) => row.name,
  },
  {
    id: "bucket",
    head: "Bucket",
    cell: (row) => <span className="font-mono text-meta">{row.bucket}</span>,
  },
  {
    id: "endpoint",
    head: "Endpoint",
    tone: "wrap",
    cell: (row) => <span className="font-mono text-meta">{row.endpoint}</span>,
  },
  {
    id: "region",
    head: "Region",
    tone: "muted",
    cell: (row) => row.region || <Dash word="None" />,
  },
];

/** The body both the save and the test send. One shape, one place. */
function toInput(values: DestinationValues): DestinationInput {
  return {
    name: values.name,
    provider: values.provider || null,
    endpoint: values.endpoint,
    region: values.region,
    bucket: values.bucket,
    accessKey: values.accessKey,
    secretAccessKey: values.secretAccessKey,
  };
}

export function destinationSpec(
  onDone: () => Promise<unknown>,
  /** The Hosted instance's probe-from picker; `null` asks nothing. */
  probeFrom: ProbeFrom | null = null,
): ResourceSpec<Destination, DestinationValues> {
  return {
    noun: "destination",
    plural: "destinations",
    title: "Destinations",
    lede: "Database dumps and volume archives are written here. Cloudgate reaches the bucket with rclone, so anything S3-compatible works.",
    icon: "hdd",
    addLabel: "Add a destination",
    emptyTitle: "No destinations yet",
    emptyBody:
      "Add a bucket and Cloudgate can start writing backups off the machine the data is on — which is the only kind of backup that survives losing that machine.",
    tableLabel: "Backup destinations",

    columns: destinationColumns,
    getRowId: (row) => row.destinationId,
    rowName: (row) => row.name,
    defaultSort: { id: "name", dir: "asc" },

    schema,
    fields: [
      {
        name: "name",
        label: "Name",
        kind: "text",
        placeholder: example("Nightly backups"),
        hint: "What this bucket is called in Cloudgate. Only you see it.",
      },
      {
        name: "endpoint",
        label: "Endpoint",
        kind: "text",
        mono: true,
        placeholder: "https://s3.eu-west-1.amazonaws.com",
        hint: "The API endpoint, with its scheme. MinIO and friends have their own.",
      },
      {
        name: "region",
        label: "Region",
        kind: "text",
        mono: true,
        optional: true,
        placeholder: example("eu-west-1"),
        hint: "Leave it empty if your provider has no regions.",
      },
      {
        name: "bucket",
        label: "Bucket",
        kind: "text",
        mono: true,
        placeholder: example("cloudgate-backups"),
      },
      {
        name: "provider",
        label: "Provider",
        kind: "text",
        optional: true,
        placeholder: example("Minio"),
        hint: "rclone's own provider name, when the bucket needs one — AWS, Minio, Wasabi, Cloudflare. Leave it empty and rclone works it out.",
      },
      {
        name: "accessKey",
        label: "Access key",
        kind: "text",
        mono: true,
      },
      {
        name: "secretAccessKey",
        label: "Secret access key",
        kind: "password",
        hint: "Stored encrypted and never shown again. Leave it empty when editing to keep the one already saved — a test then probes with the stored one.",
      },
      ...(probeFrom ? [probeServerField<DestinationValues>(probeFrom)] : []),
    ],

    toDefaults: (row) => ({
      destinationId: row?.destinationId ?? "",
      name: row?.name ?? "",
      provider: row?.provider ?? "",
      endpoint: row?.endpoint ?? "",
      region: row?.region ?? "",
      bucket: row?.bucket ?? "",
      accessKey: row?.accessKey ?? "",
      secretAccessKey: "",
      serverId: "",
    }),

    secrets: [
      {
        name: "secretAccessKey",
        label: "the secret access key",
        required: true,
      },
    ],
    test: {
      label: "Test connection",
      // Only an *add* with an empty secret box has nothing to probe with. On an
      // edit the row itself is the credential, so the button stays on.
      blocked: (values) =>
        values.destinationId || values.secretAccessKey
          ? probeServerBlocked(probeFrom, values)
          : "Fill in the secret access key and the test probes the bucket with it. Nothing is saved yet, so there is nothing else to probe with.",
      run: async (values) => {
        if (values.secretAccessKey) {
          await destinationsApi.testConnection({
            ...toInput(values),
            ...(values.serverId ? { serverId: values.serverId } : {}),
          });
          return `Cloudgate listed ${values.bucket} with the key you typed.`;
        }
        // The saved row is what gets probed — including its bucket and its
        // endpoint, not the ones on screen. Said in the answer rather than as a
        // warning beforehand, because this is the moment it can be believed.
        await (values.serverId
          ? destinationsApi.testSavedConnection(
              values.destinationId,
              values.serverId,
            )
          : destinationsApi.testSavedConnection(values.destinationId));
        return "Cloudgate reached this destination as it is saved. Anything changed in this dialog was not part of that — save it, or type the secret access key in to probe these values instead.";
      },
      // **A refusal from this route contains the secret.**
      // `destinations.service.ts` builds an
      // `rclone ls --s3-secret-access-key="…"` command line and rethrows the
      // shell's failure verbatim, so a 400 carries the key in plain text —
      // rendering it would print a live credential on a shared screen, which is
      // the one thing the rest of this phase is careful not to do. Found by
      // driving a deliberately wrong secret and reading what came back.
      redact: (message, values) =>
        redactSecrets(message, [values.secretAccessKey, values.accessKey]),
    },

    // What `/destinations` asks of each write. The edit is `destination: ['create']`
    // too: that is what its `PATCH` names, and there is no `update` to ask for.
    permissions: {
      create: { destination: ["create"] },
      update: { destination: ["create"] },
      remove: { destination: ["delete"] },
    },
    create: async (values) => {
      await destinationsApi.create(toInput(values));
      await onDone();
    },

    update: async (row, values) => {
      const { secretAccessKey, ...rest } = toInput(values);
      await destinationsApi.update(row.destinationId, {
        ...rest,
        // Omitted rather than sent empty: a `PATCH` that does not mention the
        // column leaves it as it was, which is what "leave it blank to keep the
        // saved one" has to mean.
        ...(secretAccessKey ? { secretAccessKey } : {}),
      });
      await onDone();
    },

    remove: async (row) => {
      await destinationsApi.remove(row.destinationId);
      await onDone();
    },

    // The backend refuses while a schedule still writes here, and names each
    // one with the service it lives on; the dialog shows that refusal
    // in place. So this says what a removal that goes through actually does,
    // and what stops one — not a cascade that no longer happens.
    deleteNote: (row) => (
      <>
        Nothing in the bucket is deleted — this removes Cloudgate&rsquo;s
        credentials for it. While a database backup schedule or a volume backup
        still writes to <strong className="font-medium text-tx">{row.name}</strong>,
        it cannot be removed; the refusal names each one and the service it is
        on, so you can point it elsewhere or delete it first.
      </>
    ),
  };
}
